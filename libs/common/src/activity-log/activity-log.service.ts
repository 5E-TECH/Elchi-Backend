import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  AuditContext,
  RequestContextStore,
  pickAuditActor,
  pickAuditContext,
  requestContext,
} from '../context/request-context';
import { maskPhonesForLog } from '../pii/mask-phones';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogArchive } from './activity-log-archive.entity';
import { computeDiff } from './diff';
import {
  ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
  quoteActivityLogTable,
  resolveDeviceRetentionMs,
  stripDeviceMetadataBatched,
} from './retention';
import {
  ACTIVITY_LOG_SERVICE_NAME,
  ActivityAction,
  ActivityChangeInput,
  ActivityLogInput,
  ActivityLogPage,
  ActivityLogQuery,
} from './types';

function normaliseJsonb(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // Wrap primitives/arrays so JSONB column always sees an object shape.
  return { value };
}

/** Oddiy sahifa chegarasi (`{svc}.activity_log.find_all`). */
export const ACTIVITY_LOG_PAGE_MAX = 500;
/**
 * 8eYmt4NV — `keys_only` rejimida bitta so'rovdagi kalitlar (id + cursor_ts)
 * chegarasi: gateway chuqur sahifa ofsetini shu oynada aniq topadi
 * (`ACTIVITY_FEED_OFFSET_CAP` + sahifa).
 */
export const ACTIVITY_LOG_KEYS_MAX = 10_100;

/**
 * Mikrosekundli, leksikografik tartiblanadigan UTC satr:
 * `2026-10-14T09:10:19.064123Z`. Gateway k-way merge shu satr bo'yicha
 * solishtiradi va kursor sifatida qaytaradi.
 */
const ACTIVITY_CURSOR_TS_SQL = `to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** Kursor yo'li faqat yangi parametrlardan biri BERILGANDA (8eYmt4NV). */
function isCursorQuery(q: ActivityLogQuery): boolean {
  return (
    q.before_ts !== undefined ||
    q.before_id !== undefined ||
    q.before_inclusive !== undefined ||
    q.keys_only !== undefined ||
    q.with_total !== undefined
  );
}

function parseCursorTs(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return CURSOR_TS_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** `activity_logs.trace_id` — VARCHAR(64). */
const TRACE_ID_MAX = 64;
/** Tavsif — qisqa gap; himoya chegarasi (ustun `text`). */
export const ACTIVITY_DESCRIPTION_MAX = 500;

/**
 * Kontekstdagi IP/qurilmani metadata bilan birlashtiradi (f2Ud5tju, BeePost
 * `activity-log.service.ts:76-83` naqshi): avtomatik qiymatlar AVVAL, ustidan
 * chaqiruvchining metadata'si — ya'ni chaqiruvchi bergan `ip` USTUN turadi.
 * Chaqiruvchidagi `undefined` qiymat avtomatikni o'chirmaydi (spread `undefined`
 * ni yozib, JSON'da kalit yo'qolib qolardi); aniq `null` esa o'chiradi.
 *
 * Kontekst bo'sh (cron/bot) va metadata berilmagan bo'lsa — `null` (avvalgidek).
 */
function mergeAuditMetadata(
  auto: AuditContext,
  given: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!given && Object.keys(auto).length === 0) return null;
  const merged: Record<string, unknown> = { ...auto };
  for (const [key, value] of Object.entries(given ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Tavsifni yozishdan oldin tozalaydi (2WRzdWpZ): bo'shliqlar yig'iladi, bo'sh
 * satr → NULL, uzunlik cheklanadi. ⚠️ HIMOYA QATLAMI: gapga tasodifan telefon
 * tushib qolsa (`maskPhonesForLog`) `+99890*****67` ko'rinishiga keltiriladi —
 * jurnal PII omboriga aylanmasin. Asosiy qoida baribir quruvchilarda
 * (`ActivityDescribeUz` PII maydonini qabul qilmaydi).
 */
function normaliseDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = maskPhonesForLog(value.replace(/\s+/g, ' ').trim());
  return clean ? clean.slice(0, ACTIVITY_DESCRIPTION_MAX) : null;
}

/**
 * Qatorning aktyor ustunlari (fQi6NNUL / y8CxCtcK, BeePost
 * `activity-log.service.ts:44-74` dagi zaxira yo'l).
 *
 * - `user_id`: chaqiruvchi bergani, bo'lmasa kontekstdagi (gateway JWT →
 *   `x-audit-actor` sarlavhasi) — avvalgidek.
 * - `user_name` / `user_role`: chaqiruvchi bergani USTUN; bo'lmasa kontekstdan
 *   — LEKIN faqat qator AYNAN kontekst aktyoriga tegishli bo'lsa (chaqiruvchi
 *   boshqa `user_id` bergan bo'lsa, so'rov egasining ismi begona id'ga
 *   yopishtirilmaydi). Yozilgan qiymat MUZLAYDI: keyin rol o'zgarsa ham eski
 *   qator o'zgarmaydi.
 */
function resolveRowActor(
  input: Pick<ActivityLogInput, 'user_id' | 'user_name' | 'user_role'>,
  ctx: RequestContextStore | undefined,
): {
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
} {
  const ctxActor = pickAuditActor(ctx);
  const given =
    input.user_id === null || input.user_id === undefined
      ? null
      : String(input.user_id);
  const userId = given ?? ctxActor.userId ?? null;
  const sameActor =
    !!ctxActor.userId && userId !== null && userId === ctxActor.userId;
  return {
    user_id: userId,
    user_name:
      input.user_name ?? (sameActor ? (ctxActor.userName ?? null) : null),
    user_role:
      input.user_role ?? (sameActor ? (ctxActor.userRole ?? null) : null),
  };
}

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: Repository<ActivityLog>,
    @Optional()
    @Inject(ACTIVITY_LOG_SERVICE_NAME)
    private readonly serviceName: string | null = null,
  ) {}

  /**
   * Persist an audit event. Failures are caught — audit logging must not
   * break the business operation that triggered it. If the write fails,
   * the error is logged and processing continues.
   */
  async log(input: ActivityLogInput): Promise<void> {
    try {
      const ctx = requestContext.get();
      const traceId = input.trace_id ?? ctx?.traceId ?? null;
      const actor = resolveRowActor(input, ctx);
      const entity = this.repo.create({
        entity_type: input.entity_type,
        entity_id: String(input.entity_id),
        action: input.action,
        old_value: normaliseJsonb(input.old_value),
        new_value: normaliseJsonb(input.new_value),
        user_id: actor.user_id,
        user_name: actor.user_name,
        user_role: actor.user_role,
        service: this.serviceName,
        // Mijoz `x-request-id` sarlavhasi ustundan (VARCHAR 64) uzun bo'lsa
        // INSERT yiqilib, log JIMGINA yo'qolardi (f2Ud5tju: trace endi RMQ
        // sarlavhasi orqali HAR chaqiruvda keladi).
        trace_id: traceId ? String(traceId).slice(0, TRACE_ID_MAX) : null,
        metadata: mergeAuditMetadata(
          pickAuditContext(ctx),
          normaliseJsonb(input.metadata),
        ),
        description: normaliseDescription(input.description),
      });
      await this.repo.save(entity);
    } catch (err) {
      this.logger.error(
        `activity-log write failed for ${input.entity_type}:${input.entity_id} action=${input.action}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Log a diff between two snapshots. Only changed fields are stored.
   * If nothing changed (after default-ignore filtering), no row is written —
   * silent updates from save() should not pollute the audit table.
   */
  async logChange(input: ActivityChangeInput): Promise<void> {
    const diff = computeDiff(
      input.old_value,
      input.new_value,
      input.ignore_fields ?? [],
    );
    if (
      Object.keys(diff.before).length === 0 &&
      Object.keys(diff.after).length === 0
    ) {
      return;
    }
    await this.log({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      action: input.action ?? ActivityAction.UPDATED,
      old_value: diff.before,
      new_value: diff.after,
      user_id: input.user_id,
      user_name: input.user_name,
      user_role: input.user_role,
      trace_id: input.trace_id,
      metadata: input.metadata,
      description: input.description,
    });
  }

  async findByEntity(
    entity_type: string,
    entity_id: string | number,
    limit = 50,
  ): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { entity_type, entity_id: String(entity_id) },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async findByUser(user_id: string, limit = 50): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { user_id },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /**
   * Filterable, paginated read over this service's own activity_logs table.
   * Backs the `{service}.activity_log.find_all` message pattern; the gateway
   * fans this out across services, merges by created_at DESC, and enriches ids.
   * Rows are ordered newest-first with id as a stable tiebreak.
   */
  async query(
    q: ActivityLogQuery = {},
  ): Promise<
    ActivityLogPage<ActivityLog | (ActivityLog & { cursor_ts: string | null })>
  > {
    const page = Number(q.page) > 0 ? Math.floor(Number(q.page)) : 1;
    const rawLimit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50;
    const limit = Math.min(rawLimit, ACTIVITY_LOG_PAGE_MAX);

    const qb = this.applyQueryFilters(
      this.readRepo(q).createQueryBuilder('a'),
      q,
    );

    // 8eYmt4NV — kursor parametrlari berilsa ALOHIDA yo'l (`queryCursor`).
    // Berilmasa — eski zanjir AYNAN avvalgidek (orqaga moslik).
    if (isCursorQuery(q)) {
      return this.queryCursor(qb, q, page, rawLimit);
    }

    qb.orderBy('a.created_at', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /**
   * i6Nyedea — `archive: true` (yoki `'true'`) bo'lsa o'qish ARXIV jadvalidan
   * (`activity_logs_archive`, AYNI sxema). Arxiv entity'si `ActivityLog` ning
   * barcha ustunlariga ega (+ `archived_at`, `archive_rule`), shuning uchun
   * filtrlar/kursor zanjiri o'zgarmaydi. Aks holda — hot jadval, avvalgidek.
   */
  private readRepo(q: ActivityLogQuery): Repository<ActivityLog> {
    const archive = q.archive === true || `${q.archive}` === 'true';
    if (!archive) return this.repo;
    return this.repo.manager.getRepository(
      ActivityLogArchive,
    ) as unknown as Repository<ActivityLog>;
  }

  /** `query()` filtrlari (har ikki yo'l uchun bitta manba). */
  private applyQueryFilters(
    qb: SelectQueryBuilder<ActivityLog>,
    q: ActivityLogQuery,
  ): SelectQueryBuilder<ActivityLog> {
    if (q.entity_type)
      qb.andWhere('a.entity_type = :et', { et: q.entity_type });
    if (
      q.entity_id !== undefined &&
      q.entity_id !== null &&
      `${q.entity_id}` !== ''
    ) {
      qb.andWhere('a.entity_id = :eid', { eid: String(q.entity_id) });
    }
    if (q.action) qb.andWhere('a.action = :act', { act: q.action });
    if (q.user_id) qb.andWhere('a.user_id = :uid', { uid: String(q.user_id) });
    if (q.user_role)
      qb.andWhere('a.user_role ILIKE :urole', { urole: `%${q.user_role}%` });
    if (q.trace_id) qb.andWhere('a.trace_id = :tid', { tid: q.trace_id });
    // Parse date bounds defensively — an invalid value must be IGNORED, never
    // forwarded to the driver (which would throw and silently empty the feed).
    const parseDate = (v: string | Date): Date | null => {
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const isDateOnly = (v: string | Date): boolean =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
    if (q.from) {
      const from = parseDate(q.from);
      if (from) qb.andWhere('a.created_at >= :from', { from });
    }
    if (q.to) {
      let to = parseDate(q.to);
      // A date-only upper bound should be inclusive of that whole day.
      if (to && isDateOnly(q.to)) to = new Date(to.getTime() + 86_400_000 - 1);
      if (to) qb.andWhere('a.created_at <= :to', { to });
    }
    if (q.search && q.search.trim()) {
      const term = `%${q.search.trim()}%`;
      // `a.description` (2WRzdWpZ) — "bekor" deb yozilsa "Buyurtma #… bekor
      // qilindi" qatorlari topiladi. Ustunda GIN `gin_trgm_ops` indeksi bor
      // (migratsiya 1716000000062).
      qb.andWhere(
        '(a.entity_type ILIKE :s OR a.entity_id ILIKE :s OR a.action ILIKE :s OR a.user_name ILIKE :s OR a.description ILIKE :s)',
        { s: term },
      );
    }
    return qb;
  }

  /**
   * 8eYmt4NV — gateway k-way merge uchun KEYSET o'qish. Har qatorga
   * `cursor_ts` (mikrosekundli UTC satr) qo'shiladi; `keys_only` — faqat
   * `{ id, cursor_ts }` (chuqur ofsetni arzon topish uchun).
   */
  private async queryCursor(
    qb: SelectQueryBuilder<ActivityLog>,
    q: ActivityLogQuery,
    page: number,
    rawLimit: number,
  ): Promise<ActivityLogPage<ActivityLog & { cursor_ts: string | null }>> {
    const keysOnly = q.keys_only === true || `${q.keys_only}` === 'true';
    const limit = Math.min(
      rawLimit,
      keysOnly ? ACTIVITY_LOG_KEYS_MAX : ACTIVITY_LOG_PAGE_MAX,
    );
    const withTotal = !(
      q.with_total === false || `${q.with_total}` === 'false'
    );

    // Jami — kursor shartidan OLDIN (filtrlarning to'liq jami; sahifa soni
    // shundan hisoblanadi). `with_total=false` — gateway 2-fazasi, sanash yo'q.
    const total = withTotal ? await qb.getCount() : null;

    /**
     * 8eYmt4NV — KEYSET kursor: `(created_at, id) < (before_ts, before_id)`.
     * `before_ts` — mikrosekundli UTC satr (`cursor_ts`, JS Date ms ga
     * kesilsa bir ms ichidagi qatorlar yo'qolardi). Noto'g'ri qiymat — e'tiborsiz
     * (sana chegaralari kabi, so'rov yiqilmaydi).
     */
    const beforeTs = parseCursorTs(q.before_ts);
    if (beforeTs) {
      const beforeId =
        q.before_id !== undefined &&
        q.before_id !== null &&
        /^\d{1,19}$/.test(String(q.before_id))
          ? String(q.before_id)
          : null;
      if (beforeId) {
        qb.andWhere(
          '(a.created_at < CAST(:bts AS timestamptz) OR (a.created_at = CAST(:bts AS timestamptz) AND a.id < CAST(:bid AS bigint)))',
          { bts: beforeTs, bid: beforeId },
        );
      } else if (
        q.before_inclusive === true ||
        `${q.before_inclusive}` === 'true'
      ) {
        qb.andWhere('a.created_at <= CAST(:bts AS timestamptz)', {
          bts: beforeTs,
        });
      } else {
        qb.andWhere('a.created_at < CAST(:bts AS timestamptz)', {
          bts: beforeTs,
        });
      }
    }

    const offset = (page - 1) * limit;
    let items: Array<ActivityLog & { cursor_ts: string | null }>;
    if (keysOnly) {
      const raw: Array<{ id: string | number; cursor_ts: string | null }> =
        await qb
          .select('a.id', 'id')
          .addSelect(ACTIVITY_CURSOR_TS_SQL, 'cursor_ts')
          .orderBy('a.created_at', 'DESC')
          .addOrderBy('a.id', 'DESC')
          .offset(offset)
          .limit(limit)
          .getRawMany();
      items = raw.map(
        (r) =>
          ({
            id: String(r.id),
            cursor_ts: r.cursor_ts ?? null,
          }) as ActivityLog & {
            cursor_ts: string | null;
          },
      );
    } else {
      qb.addSelect(ACTIVITY_CURSOR_TS_SQL, 'a_cursor_ts')
        .orderBy('a.created_at', 'DESC')
        .addOrderBy('a.id', 'DESC')
        .skip(offset)
        .take(limit);
      const { entities, raw } = await qb.getRawAndEntities();
      const cursorById = new Map<string, string | null>(
        (raw as Array<Record<string, unknown>>).map((r) => [
          String(r.a_id),
          (r.a_cursor_ts as string | null) ?? null,
        ]),
      );
      items = entities.map((e) =>
        Object.assign(e, { cursor_ts: cursorById.get(String(e.id)) ?? null }),
      );
    }
    const knownTotal = total ?? offset + items.length;
    return {
      items,
      meta: {
        page,
        limit,
        total: knownTotal,
        totalPages: Math.max(1, Math.ceil(knownTotal / limit)),
      },
    };
  }

  /**
   * Best-effort retention: delete rows older than `olderThanMs`.
   *
   * (f2Ud5tju) Shundan KEYIN IP/qurilma maydonlari uchun QISQAROQ muddat:
   * `ACTIVITY_LOG_DEVICE_RETENTION_DAYS` (sukut 30 kun, `olderThanMs` dan
   * katta bo'lsa — `olderThanMs`) dan eski qatorlarda `metadata` dan `ip`,
   * `user_agent`, `device_id`, `device_name` olib tashlanadi, qator qoladi.
   * Tozalash xatosi DELETE natijasini yo'qotmaydi (faqat ogohlantirish).
   */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('created_at < :cutoff', { cutoff })
      .execute();
    try {
      const stripped = await this.stripDeviceMetadata(
        resolveDeviceRetentionMs(olderThanMs),
      );
      if (stripped) {
        this.logger.log(
          `activity_logs retention: ${stripped} qatorda ip/qurilma maydonlari olib tashlandi`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `activity_logs ip/qurilma retention xato: ${(err as Error).message}`,
      );
    }
    return result.affected ?? 0;
  }

  /**
   * `olderThanMs` dan eski qatorlarda `metadata` dan IP/qurilma kalitlarini
   * PARTIYALAB olib tashlaydi (f2Ud5tju); tozalangan qatorlar sonini
   * qaytaradi. Faqat shu servisning o'z sxemasidagi jadval — barcha sxemalar
   * `scripts/prune-activity-logs.ts` da.
   */
  async stripDeviceMetadata(
    olderThanMs: number,
    batchSize: number = ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
  ): Promise<number> {
    const { schema, tableName } = this.repo.metadata;
    return stripDeviceMetadataBatched(
      (sql, params) => this.repo.query(sql, params),
      quoteActivityLogTable(schema, tableName),
      new Date(Date.now() - olderThanMs),
      batchSize,
    );
  }
}
