import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderLookupService } from '../lookup/order-lookup.service';
import {
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
} from '../notification/order-notification.service';
import { cancelReturnBranchId } from './cancel-return';
import {
  buildCancelReturnEscalationPayload,
  buildCancelReturnReminderPayload,
  cancelReturnAwaitingSql,
  cancelReturnReceivedAtSql,
  quoteTablePath,
  type CancelReturnDueOrder,
  type CancelReturnNotificationPayload,
} from './cancel-return-reminder';

/** Bir yugurishda ko'pi bilan shuncha buyurtma (qolgani keyingi tikda). */
export const CANCEL_RETURN_REMINDER_BATCH = 500;

/**
 * Ko'p replika: bir vaqtda faqat BITTA yugurish (`pg_try_advisory_xact_lock`,
 * tranzaksiya tugashi bilan bo'shaydi). Ikkinchi replika kutmaydi — o'tkazib
 * yuboradi.
 */
export const CANCEL_RETURN_REMIND_LOCK = 'order:cancel_return:remind';
export const CANCEL_RETURN_ESCALATE_LOCK = 'order:cancel_return:escalate';

export interface CancelReturnStepResult {
  /** `false` — boshqa replika ayni paytda ishlayapti (hech narsa qilinmadi). */
  locked: boolean;
  /** Belgilangan buyurtmalar. */
  orders: number;
  /** Outbox'ga yozilgan bildirishnomalar. */
  notifications: number;
  /** Partiya to'ldi — qolgani bo'lishi mumkin (keyingi tikda davom). */
  hit_limit: boolean;
}

type Kind = 'remind' | 'escalate';

const COLUMN: Record<Kind, 'handover_notified_at' | 'handover_escalated_at'> = {
  remind: 'handover_notified_at',
  escalate: 'handover_escalated_at',
};

type DueRow = {
  id: unknown;
  market_id: unknown;
  holder_type: unknown;
  holder_branch_id: unknown;
  branch_id: unknown;
  received_at: unknown;
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

/**
 * vNKGbg5q (BG7) — bekor posilka eslatmasi (D+3, market) va eskalatsiyasi
 * (D+7, admin). Qoidalar — `cancel-return-reminder.ts`; jadval —
 * `CancelReturnReminderScheduler`.
 *
 * ⚠️ IDEMPOTENT VA KO'P REPLIKADA XAVFSIZ. Har qadam BITTA tranzaksiya:
 *   1) `pg_try_advisory_xact_lock` — band bo'lsa qadam o'tkazib yuboriladi;
 *   2) muddati kelgan, belgisi yo'q qatorlar `FOR UPDATE SKIP LOCKED` bilan
 *      olinib, ayni so'rovda belgi qo'yiladi (`… IS NULL` sharti bilan
 *      UPDATE … RETURNING) — har buyurtmaga har bosqich BIR marta;
 *   3) bildirishnoma o'sha tranzaksiyada OUTBOX'ga yoziladi (`notification.
 *      dispatch`; Telegram — notification-service relay'i va telegram_outbox
 *      orqali). Outbox yozuvi yiqilsa — belgi ham qaytadi (rollback), keyingi
 *      tikda qayta urinadi. Telegram keyin yetmasa ham belgi qoladi (BeePost:
 *      aks holda market har kuni eslatma olardi).
 *
 * Holat, custody, pul — TEGILMAYDI.
 */
@Injectable()
export class CancelReturnReminderService {
  private readonly logger = new Logger(CancelReturnReminderService.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderTracking)
    private readonly tracking: Repository<OrderTracking>,
    private readonly outbox: OutboxService,
    @Optional() private readonly lookup?: OrderLookupService,
  ) {}

  /** D+3: market bo'yicha BITTA eslatma (in-app + «bekor» Telegram guruhi). */
  remindMarkets(
    cutoff: Date,
    now: Date = new Date(),
    limit = CANCEL_RETURN_REMINDER_BATCH,
  ): Promise<CancelReturnStepResult> {
    return this.step('remind', cutoff, now, limit, (rows) => {
      const byMarket = new Map<string, CancelReturnDueOrder[]>();
      for (const row of rows) {
        const list = byMarket.get(row.market_id) ?? [];
        list.push(row);
        byMarket.set(row.market_id, list);
      }
      return [...byMarket].map(([marketId, list]) =>
        buildCancelReturnReminderPayload(marketId, list, now),
      );
    });
  }

  /** D+7: buyurtma bo'yicha admin navbatiga eskalatsiya. */
  escalateStale(
    cutoff: Date,
    now: Date = new Date(),
    limit = CANCEL_RETURN_REMINDER_BATCH,
  ): Promise<CancelReturnStepResult> {
    return this.step('escalate', cutoff, now, limit, (rows) =>
      rows.map((row) => buildCancelReturnEscalationPayload(row, now)),
    );
  }

  private async step(
    kind: Kind,
    cutoff: Date,
    now: Date,
    limit: number,
    build: (
      rows: CancelReturnDueOrder[],
    ) => Array<CancelReturnNotificationPayload | null>,
  ): Promise<CancelReturnStepResult> {
    // HQ id — RPC (keshlangan); tranzaksiyadan OLDIN (qulf ushlab RPC kutilmasin).
    const hqBranchId = await Promise.resolve(this.lookup?.getHqBranchId())
      .then((id) => (id ? String(id) : null))
      .catch(() => null);

    const result = await this.orders.manager.transaction(async (manager) => {
      const [lock] = await manager.query<Array<{ locked?: boolean }>>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"',
        [
          kind === 'remind'
            ? CANCEL_RETURN_REMIND_LOCK
            : CANCEL_RETURN_ESCALATE_LOCK,
        ],
      );
      if (!lock?.locked) {
        return { locked: false, orders: 0, notifications: 0, hit_limit: false };
      }

      const rows = await this.markDue(
        manager,
        kind,
        cutoff,
        now,
        limit,
        hqBranchId,
      );
      if (!rows.length) {
        return { locked: true, orders: 0, notifications: 0, hit_limit: false };
      }

      const names = await this.loadBranchNames(
        manager,
        rows.map((row) => row.place_id).filter((id): id is string => !!id),
      );
      const due = rows.map((row) => ({
        ...row,
        place_name: row.place_id ? (names.get(row.place_id) ?? null) : null,
      }));

      let notifications = 0;
      for (const payload of build(due)) {
        if (!payload) continue;
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
        `Bekor qaytarish ${kind === 'remind' ? 'eslatmasi' : 'eskalatsiyasi'}: ${result.orders} posilka, ${result.notifications} bildirishnoma`,
      );
    }
    return result;
  }

  /**
   * Muddati kelgan, belgisi yo'q kutayotgan bekorlarni BELGILAYDI va
   * qaytaradi (bitta so'rov: tanlash `FOR UPDATE SKIP LOCKED` + shartli
   * UPDATE … RETURNING).
   */
  private async markDue(
    manager: EntityManager,
    kind: Kind,
    cutoff: Date,
    now: Date,
    limit: number,
    hqBranchId: string | null,
  ): Promise<Array<Omit<CancelReturnDueOrder, 'place_name'>>> {
    const column = COLUMN[kind];
    const orders = quoteTablePath(this.orders.metadata.tablePath);
    const tracking = quoteTablePath(this.tracking.metadata.tablePath);
    const receivedAt = cancelReturnReceivedAtSql(tracking, 'o');
    const raw: unknown = await manager.query(
      `WITH due AS (
         SELECT o.id, ${receivedAt} AS received_at
           FROM ${orders} o
          WHERE ${cancelReturnAwaitingSql('o')}
            AND o.${column} IS NULL
            AND ${receivedAt} <= $1
          ORDER BY o.market_id, o.id
          LIMIT $2
          FOR UPDATE OF o SKIP LOCKED
       )
       UPDATE ${orders} AS u
          SET ${column} = $3
         FROM due
        WHERE u.id = due.id
          AND u.${column} IS NULL
       RETURNING u.id::text AS id,
                 u.market_id::text AS market_id,
                 u.holder_type::text AS holder_type,
                 u.holder_branch_id::text AS holder_branch_id,
                 u.branch_id::text AS branch_id,
                 due.received_at AS received_at`,
      [cutoff, limit, now],
    );
    // TypeORM (postgres) UPDATE uchun `[rows, rowCount]` qaytaradi.
    const list = (
      Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
    ) as DueRow[];
    const rows: Array<Omit<CancelReturnDueOrder, 'place_name'>> = [];
    for (const row of Array.isArray(list) ? list : []) {
      const receivedAtValue = toDate(row.received_at);
      const id = idText(row.id);
      if (!id || !receivedAtValue) continue;
      const stage =
        idText(row.holder_type).toUpperCase() === 'HQ' ? 'hq' : 'branch';
      rows.push({
        id,
        market_id: idText(row.market_id),
        stage,
        place_id: cancelReturnBranchId(
          {
            holder_type: row.holder_type,
            holder_branch_id: row.holder_branch_id,
            branch_id: row.branch_id,
          },
          stage,
          hqBranchId,
        ),
        received_at: receivedAtValue,
      });
    }
    return rows.sort(
      (a, b) =>
        Number(a.market_id) - Number(b.market_id) ||
        Number(a.id) - Number(b.id),
    );
  }

  /** Filial (HQ ham) nomlari — `branch_schema.branches` (jadval bo'lmasa bo'sh). */
  private async loadBranchNames(
    manager: EntityManager,
    ids: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = [...new Set(ids)];
    if (!unique.length) return result;
    const [table] = await manager.query<Array<{ ok?: boolean }>>(
      `SELECT to_regclass('"branch_schema"."branches"') IS NOT NULL AS "ok"`,
    );
    if (!table?.ok) return result;
    const rows = await manager.query<Array<{ id: unknown; name: unknown }>>(
      `SELECT "id"::text AS "id", "name"
         FROM "branch_schema"."branches"
        WHERE "id" = ANY($1::bigint[])`,
      [unique],
    );
    for (const row of rows ?? []) {
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      if (name) result.set(String(row.id), name);
    }
    return result;
  }
}
