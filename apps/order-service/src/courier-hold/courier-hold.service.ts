import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import {
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
} from '../notification/order-notification.service';
import { quoteTablePath } from '../cancel-return/cancel-return-reminder';
import {
  COURIER_HOLD_DEADLINE_HOURS,
  COURIER_HOLD_NEAR_FROM_HOURS,
  COURIER_HOLD_OVER_HOURS,
  HOUR_MS,
  buildCourierHoldCourierPayload,
  buildCourierHoldMarketPayload,
  courierHoldHours,
  courierHoldSql,
  type CourierHoldDueOrder,
  type CourierHoldNotificationPayload,
} from './courier-hold';

/** Bir yugurishda ko'pi bilan shuncha buyurtma (qolgani keyingi tikda). */
export const COURIER_HOLD_WARN_BATCH = 500;

/**
 * Ko'p replika: bir vaqtda faqat BITTA yugurish (`pg_try_advisory_xact_lock`,
 * tranzaksiya tugashi bilan bo'shaydi). Ikkinchi replika kutmaydi.
 */
export const COURIER_HOLD_WARN_LOCK = 'order:courier_hold:warn';

export interface CourierHoldWarnResult {
  /** `false` — boshqa replika ayni paytda ishlayapti (hech narsa qilinmadi). */
  locked: boolean;
  /** Belgilangan buyurtmalar. */
  orders: number;
  /** Outbox'ga yozilgan bildirishnomalar (kuryer + market). */
  notifications: number;
  /** Partiya to'ldi — qolgani bo'lishi mumkin. */
  hit_limit: boolean;
}

/** `order.courier_hold.summary` so'rovi (doira gateway'da hal qilinadi). */
export interface CourierHoldSummaryQuery {
  market_id?: string;
  /** Menejer filiali — GET /orders dagi filial doirasi bilan bir xil. */
  branch_id?: string;
  region_id?: string;
  /** Kuryer o'zi (yoki SA/admin filtri) — `holder_courier_id`. */
  courier_ids?: string[];
}

export interface CourierHoldSummaryRow {
  courier_id: string;
  /** Faol (sotilmagan, bekor qilinmagan) buyurtmalar. */
  total: number;
  under_36: number;
  near_48: number;
  over_48: number;
  over_72: number;
  /** Eng uzoq turgan faol buyurtmaning `last_handover_at` i (ISO). */
  oldest_since: string | null;
  oldest_hours: number | null;
  /** Kuryerda turgan, hali qaytarish pochtasiga qo'yilmagan bekorlar. */
  cancelled_held: number;
}

export interface CourierHoldSummary {
  couriers: CourierHoldSummaryRow[];
  totals: Omit<CourierHoldSummaryRow, 'courier_id' | 'oldest_since'> & {
    couriers: number;
  };
  /** Hisob payti (ISO) — soatlar shundan. */
  now: string;
  thresholds: { near_from: number; deadline: number; over: number };
}

type DueRow = {
  id: unknown;
  market_id: unknown;
  courier_id: unknown;
  since: unknown;
};

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : null;
};

const idText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const intOf = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
};

const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,19}$/.test(value);

/**
 * onXzDc5n — KURYERDAGI BUYURTMALAR: kuryer bo'yicha jamlama va 36 soatlik
 * («48 soatga yaqinlashdi») ogohlantirish. Qoidalar — `courier-hold.ts`;
 * jadval — `CourierHoldWarningScheduler`. Ro'yxatlarning o'zi — GET /orders
 * `courier_hold` filtri (`OrderServiceService.findAll`).
 *
 * ⚠️ OGOHLANTIRISH IDEMPOTENT VA KO'P REPLIKADA XAVFSIZ (vNKGbg5q naqshi).
 * Bitta tranzaksiya:
 *   1) `pg_try_advisory_xact_lock` — band bo'lsa o'tkazib yuboriladi;
 *   2) 36 ≤ soat < 48 oralig'idagi, shu kuryer topshirishida hali xabar
 *      bermagan qatorlar `FOR UPDATE SKIP LOCKED` bilan olinib, ayni so'rovda
 *      belgi qo'yiladi (`courier_hold_warned_at`, shartli UPDATE … RETURNING);
 *   3) bildirishnomalar o'sha tranzaksiyada OUTBOX'ga (`notification.dispatch`)
 *      — kuryer bo'yicha bitta, market bo'yicha bitta. Outbox yiqilsa belgi
 *      ham qaytadi. Telegram keyin yetmasa ham belgi qoladi (takror yo'q).
 *
 * Holat, custody, pul — TEGILMAYDI.
 */
@Injectable()
export class CourierHoldService {
  private readonly logger = new Logger(CourierHoldService.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly outbox: OutboxService,
  ) {}

  private get table(): string {
    return quoteTablePath(this.orders.metadata.tablePath);
  }

  /**
   * Kuryer bo'yicha jamlama: faol buyurtmalar soat oraliqlari bilan va
   * kuryerda qolgan bekorlar. Eng uzoq turgan kuryer birinchi.
   */
  async summary(
    query: CourierHoldSummaryQuery = {},
    now: Date = new Date(),
  ): Promise<CourierHoldSummary> {
    const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
    const params: unknown[] = [
      ago(COURIER_HOLD_NEAR_FROM_HOURS),
      ago(COURIER_HOLD_DEADLINE_HOURS),
      ago(COURIER_HOLD_OVER_HOURS),
    ];
    const where: string[] = [
      `o.holder_type = 'COURIER'`,
      `o.holder_courier_id IS NOT NULL`,
      `o.is_deleted = false`,
      `o.deleted_at IS NULL`,
      `(o.status IN ('on the road', 'waiting', 'waiting_customer', 'cancelled'))`,
    ];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (isId(query.market_id))
      add((n) => `o.market_id = $${n}`, query.market_id);
    if (isId(query.region_id))
      add((n) => `o.region_id = $${n}`, query.region_id);
    if (isId(query.branch_id)) {
      add(
        (n) =>
          `(o.branch_id = $${n} OR o.holder_branch_id = $${n} OR o.home_branch_id = $${n})`,
        query.branch_id,
      );
    }
    if (Array.isArray(query.courier_ids)) {
      const ids = [...new Set(query.courier_ids.map(idText).filter(isId))];
      // Bo'sh to'plam — hech narsa (fail-closed: filialida kuryer yo'q menejer).
      if (!ids.length) return this.emptySummary(now);
      add((n) => `o.holder_courier_id = ANY($${n}::bigint[])`, ids);
    }
    const active = courierHoldSql('o');
    const rows = await this.orders.query<Array<Record<string, unknown>>>(
      `SELECT o.holder_courier_id::text AS courier_id,
              COUNT(*) FILTER (WHERE ${active})::int AS total,
              COUNT(*) FILTER (WHERE ${active} AND o.last_handover_at > $1)::int AS under_36,
              COUNT(*) FILTER (WHERE ${active} AND o.last_handover_at <= $1 AND o.last_handover_at > $2)::int AS near_48,
              COUNT(*) FILTER (WHERE ${active} AND o.last_handover_at <= $2 AND o.last_handover_at > $3)::int AS over_48,
              COUNT(*) FILTER (WHERE ${active} AND o.last_handover_at <= $3)::int AS over_72,
              MIN(o.last_handover_at) FILTER (WHERE ${active}) AS oldest_since,
              COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_held
         FROM ${this.table} o
        WHERE ${where.join(' AND ')}
        GROUP BY o.holder_courier_id
        ORDER BY MIN(o.last_handover_at) FILTER (WHERE ${active}) ASC NULLS LAST,
                 o.holder_courier_id ASC`,
      params,
    );
    const couriers: CourierHoldSummaryRow[] = (rows ?? [])
      .map((row) => {
        const since = toDate(row.oldest_since);
        return {
          courier_id: idText(row.courier_id),
          total: intOf(row.total),
          under_36: intOf(row.under_36),
          near_48: intOf(row.near_48),
          over_48: intOf(row.over_48),
          over_72: intOf(row.over_72),
          oldest_since: since ? since.toISOString() : null,
          oldest_hours: since ? courierHoldHours(since, now) : null,
          cancelled_held: intOf(row.cancelled_held),
        };
      })
      .filter((row) => isId(row.courier_id));
    const sum = (key: keyof CourierHoldSummaryRow) =>
      couriers.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
    const oldest = couriers.reduce<number | null>(
      (acc, row) =>
        row.oldest_hours === null
          ? acc
          : acc === null
            ? row.oldest_hours
            : Math.max(acc, row.oldest_hours),
      null,
    );
    return {
      couriers,
      totals: {
        couriers: couriers.length,
        total: sum('total'),
        under_36: sum('under_36'),
        near_48: sum('near_48'),
        over_48: sum('over_48'),
        over_72: sum('over_72'),
        oldest_hours: oldest,
        cancelled_held: sum('cancelled_held'),
      },
      now: now.toISOString(),
      thresholds: {
        near_from: COURIER_HOLD_NEAR_FROM_HOURS,
        deadline: COURIER_HOLD_DEADLINE_HOURS,
        over: COURIER_HOLD_OVER_HOURS,
      },
    };
  }

  private emptySummary(now: Date): CourierHoldSummary {
    return {
      couriers: [],
      totals: {
        couriers: 0,
        total: 0,
        under_36: 0,
        near_48: 0,
        over_48: 0,
        over_72: 0,
        oldest_hours: null,
        cancelled_held: 0,
      },
      now: now.toISOString(),
      thresholds: {
        near_from: COURIER_HOLD_NEAR_FROM_HOURS,
        deadline: COURIER_HOLD_DEADLINE_HOURS,
        over: COURIER_HOLD_OVER_HOURS,
      },
    };
  }

  /**
   * 36 ≤ soat < 48 oralig'iga kirgan, shu kuryer topshirishida hali xabar
   * olmagan buyurtmalar: belgilaydi va kuryer + marketga outbox orqali
   * bildirishnoma yozadi (bitta tranzaksiya).
   */
  async warnDue(
    now: Date = new Date(),
    limit = COURIER_HOLD_WARN_BATCH,
  ): Promise<CourierHoldWarnResult> {
    const result = await this.orders.manager.transaction(async (manager) => {
      const [lock] = await manager.query<Array<{ locked?: boolean }>>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"',
        [COURIER_HOLD_WARN_LOCK],
      );
      if (!lock?.locked) {
        return { locked: false, orders: 0, notifications: 0, hit_limit: false };
      }
      const rows = await this.markDue(manager, now, limit);
      if (!rows.length) {
        return { locked: true, orders: 0, notifications: 0, hit_limit: false };
      }
      let notifications = 0;
      for (const payload of this.buildPayloads(rows, now)) {
        await this.outbox.enqueue(
          NOTIFICATION_OUTBOX_TARGET,
          NOTIFICATION_DISPATCH_PATTERN,
          payload,
          { manager },
        );
        notifications += 1;
      }
      return {
        locked: true,
        orders: rows.length,
        notifications,
        hit_limit: rows.length >= limit,
      };
    });
    if (result.orders) {
      this.logger.log(
        `Kuryer 48 soat ogohlantirishi: ${result.orders} buyurtma, ${result.notifications} bildirishnoma`,
      );
    }
    return result;
  }

  /** Kuryer bo'yicha bitta + market bo'yicha bitta payload. */
  private buildPayloads(
    rows: CourierHoldDueOrder[],
    now: Date,
  ): CourierHoldNotificationPayload[] {
    const group = (key: (row: CourierHoldDueOrder) => string) => {
      const map = new Map<string, CourierHoldDueOrder[]>();
      for (const row of rows) {
        const id = key(row);
        if (!id) continue;
        const list = map.get(id) ?? [];
        list.push(row);
        map.set(id, list);
      }
      return [...map].sort((a, b) => Number(a[0]) - Number(b[0]));
    };
    const payloads: Array<CourierHoldNotificationPayload | null> = [
      ...group((row) => row.courier_id).map(([courierId, list]) =>
        buildCourierHoldCourierPayload(courierId, list, now),
      ),
      ...group((row) => row.market_id).map(([marketId, list]) =>
        buildCourierHoldMarketPayload(marketId, list, now),
      ),
    ];
    return payloads.filter(
      (payload): payload is CourierHoldNotificationPayload => payload !== null,
    );
  }

  /**
   * Muddati kelgan, belgisi yo'q qatorlarni BELGILAYDI va qaytaradi (bitta
   * so'rov: tanlash `FOR UPDATE SKIP LOCKED` + shartli UPDATE … RETURNING).
   * 48 dan oshganlar olinmaydi — «yaqinlashdi» xabari faqat oynada.
   */
  private async markDue(
    manager: EntityManager,
    now: Date,
    limit: number,
  ): Promise<CourierHoldDueOrder[]> {
    const nearFrom = new Date(
      now.getTime() - COURIER_HOLD_NEAR_FROM_HOURS * HOUR_MS,
    );
    const deadline = new Date(
      now.getTime() - COURIER_HOLD_DEADLINE_HOURS * HOUR_MS,
    );
    const table = this.table;
    const raw: unknown = await manager.query(
      `WITH due AS (
         SELECT o.id
           FROM ${table} o
          WHERE ${courierHoldSql('o')}
            AND o.holder_courier_id IS NOT NULL
            AND o.return_requested = false
            AND o.last_handover_at <= $1
            AND o.last_handover_at > $2
            AND (o.courier_hold_warned_at IS NULL
                 OR o.courier_hold_warned_at < o.last_handover_at)
          ORDER BY o.holder_courier_id, o.id
          LIMIT $3
          FOR UPDATE OF o SKIP LOCKED
       )
       UPDATE ${table} AS u
          SET courier_hold_warned_at = $4
         FROM due
        WHERE u.id = due.id
          AND (u.courier_hold_warned_at IS NULL
               OR u.courier_hold_warned_at < u.last_handover_at)
       RETURNING u.id::text AS id,
                 u.market_id::text AS market_id,
                 u.holder_courier_id::text AS courier_id,
                 u.last_handover_at AS since`,
      [nearFrom, deadline, limit, now],
    );
    // TypeORM (postgres) UPDATE uchun `[rows, rowCount]` qaytaradi.
    const list = (
      Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
    ) as DueRow[];
    const rows: CourierHoldDueOrder[] = [];
    for (const row of Array.isArray(list) ? list : []) {
      const id = idText(row.id);
      const since = toDate(row.since);
      if (!id || !since) continue;
      rows.push({
        id,
        market_id: idText(row.market_id),
        courier_id: idText(row.courier_id),
        since,
      });
    }
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  }
}
