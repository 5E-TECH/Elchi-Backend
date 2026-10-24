import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  maskPhonesForLog,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Notification } from '../entities/notification.entity';
import {
  DISPATCH_HISTORY_STATUSES,
  DispatchHistoryStatus,
  NotificationDispatch,
} from './notification-dispatch.entity';

/**
 * "Yetkazilmadi" deb hisoblanadigan kanal holatlari (7Vozou5x #5). `in_app`
 * hisobga olinmaydi (qatorning o'zi). `queued/pending/emitted/accepted` —
 * jarayonda, `sent` — yetkazildi.
 */
export const UNDELIVERED_STATUSES: readonly string[] = Object.freeze([
  NotificationDeliveryStatus.FAILED,
  NotificationDeliveryStatus.NO_PROVIDER,
  NotificationDeliveryStatus.NOT_ELIGIBLE,
  NotificationDeliveryStatus.SKIPPED,
  NotificationDeliveryStatus.NO_SUBSCRIPTION,
  // SMS darvozasi rad etgan (kvota/kill-switch) — sms-dispatch.service.
  'blocked',
]);

/** Tashqi kanallar (in_app — tizim yozuvi, natija emas). */
const EXTERNAL_CHANNELS: readonly string[] = Object.values(
  NotificationChannel,
).filter((channel) => channel !== NotificationChannel.IN_APP);

const ERROR_MAX = 500;

/** Faqat primitiv qiymat matnga (obyekt → '', `[object Object]` emas). */
const str = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

interface UndeliveredRow {
  id: string;
  recipient_id: string;
  recipient_role: string | null;
  delivery: Record<string, unknown> | null;
}
const PAGE_MAX = 100;

export interface DispatchHistoryBegin {
  dispatch_id: string;
  created_by: string | null;
  created_by_role: string | null;
  type: string;
  category: string | null;
  priority: string | null;
  title: string;
  body: string | null;
  link: string | null;
  channels: string[];
  audience: Record<string, unknown> | null;
}

export interface DispatchHistoryFinish {
  status: DispatchHistoryStatus;
  recipients: number;
  dispatched: number;
  skipped_by_preference: number;
  by_channel: Record<string, number>;
  no_provider: string[];
  message: string;
}

/** Javob xabari → tarix holati (summarizeChannels bilan bir xil qoida). */
export function historyStatusFor(
  message: string,
  dispatched: number,
  skipped: number,
): DispatchHistoryStatus {
  if (!dispatched && skipped) return 'skipped';
  if (message === 'Notification dispatched') return 'sent';
  if (message === 'Partially dispatched') return 'partial';
  return 'inbox_only';
}

const toInt = (value: unknown, fallback: number, max = Infinity) => {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? Math.min(num, max) : fallback;
};

const DISPATCH_ID_RE = /^[\w.:-]{1,100}$/;

/**
 * Yuborilgan xabarlar tarixi (7Vozou5x): `begin` → (dispatch) → `finish` |
 * `fail`. Ro'yxat va tafsilot (kanal × holat, yetkazilmaganlar) — admin.
 *
 * ⚠️ Best-effort: tarix yozuvi yiqilsa dispatch YIQILMAYDI (faqat log) —
 * xabar yuborish tarixdan muhimroq. Lekin `begin` dagi takror (UNIQUE) —
 * ataylab: ayni `client_request_id` ikkinchi marta yubormaydi.
 */
@Injectable()
export class DispatchHistoryService {
  private readonly logger = new Logger(DispatchHistoryService.name);

  constructor(
    @InjectRepository(NotificationDispatch)
    private readonly repo: Repository<NotificationDispatch>,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  /**
   * Tarix qatorini `running` holatida ochadi. Ayni `dispatch_id` allaqachon
   * bor bo'lsa — o'sha qator (`duplicate`), yangi dispatch BOSHLANMASIN.
   */
  async begin(
    input: DispatchHistoryBegin,
  ): Promise<{ duplicate: NotificationDispatch | null }> {
    try {
      const result = await this.repo
        .createQueryBuilder()
        .insert()
        .into(NotificationDispatch)
        .values({
          ...input,
          title: input.title.slice(0, 255),
          status: 'running',
        } as never)
        .orIgnore()
        .returning(['id'])
        .execute();
      const inserted = (result.raw as unknown[] | undefined)?.length ?? 0;
      if (inserted) return { duplicate: null };
      const existing = await this.repo.findOne({
        where: { dispatch_id: input.dispatch_id },
      });
      return { duplicate: existing ?? null };
    } catch (error) {
      this.logger.error(
        `dispatch tarixi ochilmadi (${input.dispatch_id}): ${maskPhonesForLog(
          (error as Error)?.message ?? String(error),
        )}`,
      );
      return { duplicate: null };
    }
  }

  /** Yakuniy natija + kanal × holat soni (inbox qatorlaridan, bitta GROUP BY). */
  async finish(dispatchId: string, result: DispatchHistoryFinish) {
    try {
      const channelStatus = await this.channelStatus(dispatchId);
      await this.repo.update({ dispatch_id: dispatchId }, {
        ...result,
        channel_status: channelStatus,
        finished_at: new Date(),
      } as never);
      return channelStatus;
    } catch (error) {
      this.logger.error(
        `dispatch tarixi yakunlanmadi (${dispatchId}): ${maskPhonesForLog(
          (error as Error)?.message ?? String(error),
        )}`,
      );
      return null;
    }
  }

  /** Dispatch xato bilan tugadi (400 ham) — tarixda `failed` + sabab. */
  async fail(dispatchId: string, error: unknown) {
    const rpc =
      error instanceof RpcException
        ? (error.getError() as { message?: unknown })
        : null;
    const text =
      str(rpc?.message) ||
      (error instanceof Error ? error.message : str(error)) ||
      'unknown';
    try {
      await this.repo.update({ dispatch_id: dispatchId, status: 'running' }, {
        status: 'failed',
        error: maskPhonesForLog(text).slice(0, ERROR_MAX),
        finished_at: new Date(),
      } as never);
    } catch (err) {
      this.logger.error(
        `dispatch tarixi 'failed' qilinmadi (${dispatchId}): ${maskPhonesForLog(
          (err as Error)?.message ?? String(err),
        )}`,
      );
    }
  }

  /** `{ kanal: { holat: son } }` — `notifications.dispatch_id` bo'yicha. */
  async channelStatus(
    dispatchId: string,
  ): Promise<Record<string, Record<string, number>>> {
    const rows: Array<{ channel: string; status: string; n: number }> =
      await this.notifications.query(
        `SELECT e.key AS "channel", e.value AS "status", COUNT(*)::int AS "n"
           FROM "notification_schema"."notifications" n,
                jsonb_each_text(COALESCE(n."delivery", '{}'::jsonb)) e
          WHERE n."dispatch_id" = $1
            AND e.key = ANY($2::text[])
          GROUP BY 1, 2`,
        [dispatchId, [NotificationChannel.IN_APP, ...EXTERNAL_CHANNELS]],
      );
    const out: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      out[row.channel] = {
        ...(out[row.channel] ?? {}),
        [row.status]: Number(row.n),
      };
    }
    return out;
  }

  /** `GET /notifications/sent` — yangilari birinchi, sahifalab. */
  async list(query: {
    page?: unknown;
    limit?: unknown;
    status?: unknown;
    type?: unknown;
    created_by?: unknown;
  }) {
    const page = toInt(query?.page, 1);
    const limit = toInt(query?.limit, 20, PAGE_MAX);
    const qb = this.repo
      .createQueryBuilder('d')
      .where('d.isDeleted = false')
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query?.status !== undefined && query.status !== '') {
      const status = str(query.status);
      if (!DISPATCH_HISTORY_STATUSES.includes(status as DispatchHistoryStatus))
        throw new RpcException({
          statusCode: 400,
          message: `status: ${DISPATCH_HISTORY_STATUSES.join(', ')}`,
        });
      qb.andWhere('d.status = :status', { status });
    }
    if (typeof query?.type === 'string' && query.type.trim()) {
      qb.andWhere('d.type = :type', { type: query.type.trim() });
    }
    if (query?.created_by !== undefined && query.created_by !== '') {
      if (!/^\d+$/.test(str(query.created_by)))
        throw new RpcException({
          statusCode: 400,
          message: 'created_by must be numeric',
        });
      qb.andWhere('d.created_by = :createdBy', {
        createdBy: str(query.created_by),
      });
    }
    const [items, total] = await qb.getManyAndCount();
    // (NwlmrcMf) bitta odamga yuborilganlar — «Kimga: ism · rol»; ismlar
    // created_by bilan BITTA identity so'rovida.
    const singles = await this.singleRecipients(items);
    const names = await this.namesFor([
      ...(items.map((item) => item.created_by).filter(Boolean) as string[]),
      ...[...singles.values()].map((recipient) => recipient.id),
    ]);
    return successRes(
      {
        items: items.map((item) => this.toPublic(item, names, singles)),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      200,
      'Dispatch history',
    );
  }

  /**
   * `GET /notifications/sent/:dispatch_id` — to'liq matn, kanal × holat
   * (JONLI, inbox qatorlaridan) va "Yetkazilmaganlar" (ism + rol + sabab).
   */
  async detail(
    dispatchId: unknown,
    query: { page?: unknown; limit?: unknown } = {},
  ) {
    const id = str(dispatchId).trim();
    if (!DISPATCH_ID_RE.test(id))
      throw new RpcException({ statusCode: 400, message: 'dispatch_id' });
    const row = await this.repo.findOne({
      where: { dispatch_id: id, isDeleted: false },
    });
    if (!row)
      throw new RpcException({
        statusCode: 404,
        message: 'Dispatch topilmadi',
      });
    const page = toInt(query?.page, 1);
    const limit = toInt(query?.limit, 50, PAGE_MAX);

    const where = `n."dispatch_id" = $1
        AND EXISTS (
          SELECT 1 FROM jsonb_each_text(COALESCE(n."delivery", '{}'::jsonb)) e
           WHERE e.key = ANY($2::text[]) AND e.value = ANY($3::text[])
        )`;
    const params = [id, [...EXTERNAL_CHANNELS], [...UNDELIVERED_STATUSES]];
    const [countRows, undeliveredRows, channelStatus] = await Promise.all([
      this.notifications.query(
        `SELECT COUNT(*)::int AS "n" FROM "notification_schema"."notifications" n WHERE ${where}`,
        params,
      ),
      this.notifications.query(
        `SELECT n."id", n."recipient_id", n."recipient_role", n."delivery"
           FROM "notification_schema"."notifications" n
          WHERE ${where}
          ORDER BY n."id" ASC
          LIMIT $4 OFFSET $5`,
        [...params, limit, (page - 1) * limit],
      ),
      this.channelStatus(id),
    ]);
    const countRow = (countRows as Array<{ n: number }>)[0];
    const undelivered = undeliveredRows as UndeliveredRow[];
    const singles = await this.singleRecipients([row]);
    const names = await this.namesFor([
      ...undelivered.map((item) => String(item.recipient_id)),
      ...(row.created_by ? [row.created_by] : []),
      ...[...singles.values()].map((recipient) => recipient.id),
    ]);
    return successRes(
      {
        // (NwlmrcMf) `audience` — toPublic ichida (ro'yxat bilan bir xil shakl).
        ...this.toPublic(row, names, singles),
        body: row.body,
        link: row.link,
        error: row.error,
        // Jonli (DLR keyin o'zgartirgan bo'lsa ham) — saqlangan nusxa emas.
        channel_status: channelStatus,
        undelivered: {
          items: undelivered.map((item) => {
            const delivery = item.delivery ?? {};
            const failures = EXTERNAL_CHANNELS.filter((channel) =>
              UNDELIVERED_STATUSES.includes(str(delivery[channel])),
            ).map((channel) => ({
              channel,
              status: str(delivery[channel]),
              reason:
                (delivery[`${channel}_reason`] as string | undefined) ??
                (delivery[`${channel}_error`] as string | undefined) ??
                null,
            }));
            const person = names.get(String(item.recipient_id));
            return {
              notification_id: String(item.id),
              recipient_id: String(item.recipient_id),
              name: person?.name ?? null,
              role: item.recipient_role ?? person?.role ?? null,
              failures,
            };
          }),
          meta: {
            page,
            limit,
            total: Number(countRow?.n ?? 0),
            totalPages: Math.max(
              1,
              Math.ceil(Number(countRow?.n ?? 0) / limit),
            ),
          },
        },
      },
      200,
      'Dispatch',
    );
  }

  /**
   * (NwlmrcMf) `audience.recipient_ids` = 1 bo'lgan dispatchlar uchun o'sha
   * bitta qabul qiluvchi. Yangi yozuvlarda id `audience.recipient_id` da
   * (audienceSummary); eski yozuvlar (faqat aniq ro'yxat — rol/segment/
   * broadcast yo'q) — inbox qatoridan BITTA batch so'rov bilan.
   */
  private async singleRecipients(
    rows: NotificationDispatch[],
  ): Promise<Map<string, { id: string; role: string | null }>> {
    const out = new Map<string, { id: string; role: string | null }>();
    const lookup: string[] = [];
    for (const row of rows) {
      const audience = row.audience;
      if (!audience || Number(audience.recipient_ids) !== 1) continue;
      const stored = str(audience.recipient_id);
      if (/^\d+$/.test(stored)) {
        out.set(row.dispatch_id, { id: stored, role: null });
      } else if (
        Object.keys(audience).every((key) => key === 'recipient_ids')
      ) {
        lookup.push(row.dispatch_id);
      }
    }
    if (!lookup.length) return out;
    try {
      const found: Array<{
        dispatch_id: string;
        recipient_id: unknown;
        recipient_role: string | null;
      }> = await this.notifications.query(
        `SELECT DISTINCT ON (n."dispatch_id")
                n."dispatch_id", n."recipient_id", n."recipient_role"
           FROM "notification_schema"."notifications" n
          WHERE n."dispatch_id" = ANY($1::text[])
          ORDER BY n."dispatch_id", n."id" ASC`,
        [lookup],
      );
      for (const item of found) {
        const id = str(item.recipient_id);
        if (id)
          out.set(String(item.dispatch_id), {
            id,
            role: item.recipient_role ?? null,
          });
      }
    } catch (error) {
      this.logger.warn(
        `tarix: qabul qiluvchi olinmadi — ${(error as Error)?.message ?? String(error)}`,
      );
    }
    return out;
  }

  /**
   * (NwlmrcMf) «Kimga» ustuni: saqlangan auditoriya (rollar/segment/broadcast/
   * recipient_ids soni — telefon/ism YO'Q) + bitta odam bo'lsa
   * `recipient: { id, name, role }`. Ichki `recipient_id` chiqarilmaydi.
   */
  private publicAudience(
    row: NotificationDispatch,
    names: Map<string, { name: string | null; role: string | null }>,
    singles: Map<string, { id: string; role: string | null }>,
  ): Record<string, unknown> | null {
    if (!row.audience) return null;
    const audience: Record<string, unknown> = { ...row.audience };
    delete audience.recipient_id;
    const single = singles.get(row.dispatch_id);
    if (single) {
      const person = names.get(single.id);
      audience.recipient = {
        id: single.id,
        name: person?.name ?? null,
        role: single.role ?? person?.role ?? null,
      };
    }
    return audience;
  }

  private toPublic(
    row: NotificationDispatch,
    names: Map<string, { name: string | null; role: string | null }>,
    singles: Map<string, { id: string; role: string | null }> = new Map(),
  ) {
    return {
      dispatch_id: row.dispatch_id,
      status: row.status,
      type: row.type,
      category: row.category,
      priority: row.priority,
      title: row.title,
      // Ro'yxatda matn qisqa (to'liq — tafsilotda).
      body_preview: row.body ? row.body.slice(0, 160) : null,
      channels: row.channels ?? [],
      recipients: row.recipients,
      dispatched: row.dispatched,
      skipped_by_preference: row.skipped_by_preference,
      by_channel: row.by_channel,
      channel_status: row.channel_status,
      no_provider: row.no_provider ?? [],
      message: row.message,
      created_by: row.created_by
        ? {
            id: row.created_by,
            name: names.get(row.created_by)?.name ?? null,
            role: row.created_by_role,
          }
        : null,
      // (NwlmrcMf) «Kimga» — ro'yxatda ham, tafsilotda ham.
      audience: this.publicAudience(row, names, singles),
      created_at: row.createdAt,
      finished_at: row.finished_at,
    };
  }

  /**
   * Ism va rol (identity `find_by_ids` — superadmin ham). Telefon OLINMAYDI.
   * Identity javob bermasa — ismsiz (tarix ochilaveradi).
   */
  private async namesFor(
    ids: string[],
  ): Promise<Map<string, { name: string | null; role: string | null }>> {
    const unique = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
    const map = new Map<string, { name: string | null; role: string | null }>();
    if (!unique.length) return map;
    try {
      const res = await rmqSend<
        | { data?: Array<{ id: unknown; name?: unknown; role?: unknown }> }
        | Array<{ id: unknown; name?: unknown; role?: unknown }>
      >(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        {
          ids: unique,
        },
      );
      const list = Array.isArray(res) ? res : (res?.data ?? []);
      for (const user of list) {
        map.set(String(user.id), {
          name: typeof user.name === 'string' ? user.name : null,
          role: typeof user.role === 'string' ? user.role : null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `tarix: ismlar olinmadi — ${maskPhonesForLog(
          (error as Error)?.message ?? String(error),
        )}`,
      );
    }
    return map;
  }
}
