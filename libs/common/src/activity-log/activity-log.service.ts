import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditContext,
  pickAuditContext,
  requestContext,
} from '../context/request-context';
import { maskPhonesForLog } from '../pii/mask-phones';
import { ActivityLog } from './activity-log.entity';
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
      const entity = this.repo.create({
        entity_type: input.entity_type,
        entity_id: String(input.entity_id),
        action: input.action,
        old_value: normaliseJsonb(input.old_value),
        new_value: normaliseJsonb(input.new_value),
        user_id: input.user_id ?? ctx?.userId ?? null,
        user_name: input.user_name ?? null,
        user_role: input.user_role ?? null,
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
  async query(q: ActivityLogQuery = {}): Promise<ActivityLogPage<ActivityLog>> {
    const page = Number(q.page) > 0 ? Math.floor(Number(q.page)) : 1;
    const rawLimit = Number(q.limit) > 0 ? Math.floor(Number(q.limit)) : 50;
    const limit = Math.min(rawLimit, 500);

    const qb = this.repo.createQueryBuilder('a');

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
