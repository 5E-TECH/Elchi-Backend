import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ActivityLogService,
  Cashbox_type,
  NotificationChannel,
  Operation_type,
  Source_type,
  deterministicUuid,
  findNotificationType,
  renderNotificationGroupKey,
  rmqSend,
} from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import {
  ShiftReportDelivery,
  type ShiftReportChannel,
  type ShiftReportDeliveryStatus,
  type ShiftReportRecipientKind,
} from '../entities/shift-report-delivery.entity';
import {
  FinanceNotificationService,
  type FinanceNotificationPayload,
  type FinanceNotificationType,
} from '../notification/finance-notification.service';
import { ShiftAccountCheckService } from '../shift-account-check/shift-account-check.service';
import type {
  ReportChannels,
  ReportSettings,
} from '../shift-auto-close/shift-schedule.rules';
import {
  buildCourierMessage,
  buildMarketMessage,
  buildSuperadminMessage,
  deliveryReasonText,
  type CourierSlice,
  type MarketSlice,
  type ShiftMoneyBlock,
  type ShiftReportMessage,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import {
  REPORT_MIME,
  buildReportFile,
  reportFileName,
} from './shift-report.file';

const MAIN_CASHBOX_USER_ID = '0';
/** `processing` shundan eski bo'lsa (replika yiqilgan) — qayta da'vo qilinadi. */
const STALE_PROCESSING_MS = 10 * 60_000;
/** `pending` smena shuncha turgandan keyin scheduler oladi (deliverSoon ulgurmasa). */
const PENDING_GRACE_MS = 30_000;

export const IDENTITY_ACTIVE_BY_ROLE_PATTERN =
  'identity.user.active_ids_by_role';

function forbidden(message: string): never {
  throw new RpcException({ statusCode: 403, message });
}

function toRpcError(error: unknown): never {
  if (error instanceof RpcException) throw error;
  if (error instanceof NotFoundException) {
    throw new RpcException({ statusCode: 404, message: error.message });
  }
  if (error instanceof BadRequestException) {
    throw new RpcException({ statusCode: 400, message: error.message });
  }
  throw new RpcException({
    statusCode: 500,
    message: error instanceof Error ? error.message : 'Internal server error',
  });
}

/** Faqat satr / son matnga (obyekt — bo'sh satr, `[object Object]` emas). */
const text = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint'
    ? String(value)
    : '';

const short = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
};

const isId = (value: unknown): boolean =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^\d+$/.test(String(value)) &&
  !/^0+$/.test(String(value));

interface PlannedRecipient {
  kind: ShiftReportRecipientKind;
  recipient_id: string;
  message: ShiftReportMessage & { group_text?: string };
  channels: ReportChannels;
}

export interface ShiftReportDeliverResult {
  claimed: boolean;
  shift_id: string;
  round?: number;
  status?: string;
  recipients?: number;
  file_key?: string | null;
}

/**
 * gWI4gYkw — yopilgan smena hisobotini yuborish (qo'lda ham, avtomatik ham).
 *
 * Oqim: yopish tranzaksiyasi `shifts.report_status = 'pending'` qo'yadi →
 * `deliverSoon` (commit'dan keyin) yoki scheduler (har daqiqa, qolib ketgan
 * `pending` / eskirgan `processing`) → `deliver`:
 *  1. ATOMIK DA'VO: `UPDATE … SET report_status='processing' WHERE pending
 *     RETURNING` — bir nechta replikadan faqat bittasi oladi;
 *  2. snapshot (smena, kartalar, kuryer / market bo'laklari) → superadmin
 *     fayli (PDF | XLSX) → file-service (private);
 *  3. BITTA tranzaksiyada: `shift_report_deliveries` qatorlari + har qabul
 *     qiluvchiga bildirishnoma outbox qatori (deterministik
 *     `client_request_id`) + `report_status = 'sent'`. Rollback — hech narsa
 *     ketmaydi, keyingi tick qayta urinadi; notification-service ham
 *     `client_request_id` bo'yicha takrorni rad etadi.
 *
 * ⚠️ PUL HARAKATI YO'Q — faqat o'qiydi.
 */
@Injectable()
export class ShiftReportService {
  private readonly logger = new Logger(ShiftReportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    private readonly checks: ShiftAccountCheckService,
    private readonly notifications: FinanceNotificationService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
  ) {}

  /** Yopish commit'idan keyin — javobni kutdirmaydi (xato faqat WARN). */
  deliverSoon(shiftId: string): void {
    setImmediate(() => {
      this.deliver(shiftId).catch((error) =>
        this.logger.warn(`smena #${shiftId} hisoboti: ${short(error)}`),
      );
    });
  }

  /** Scheduler: qolib ketgan `pending` va eskirgan `processing` smenalar. */
  async processPending(now: Date = new Date(), limit = 20): Promise<number> {
    const rows: Array<{ id: string }> = await this.dataSource.manager
      .createQueryBuilder(Shift, 's')
      .select('s.id', 'id')
      .where('s.status = :closed', { closed: ShiftStatus.CLOSED })
      .andWhere('s.isDeleted = false')
      .andWhere(
        `((s.report_status = 'pending' AND s.closed_at < :grace)
          OR (s.report_status = 'processing' AND s.report_claimed_at < :stale))`,
        {
          grace: new Date(now.getTime() - PENDING_GRACE_MS),
          stale: new Date(now.getTime() - STALE_PROCESSING_MS),
        },
      )
      .orderBy('s.closed_at', 'ASC')
      .limit(limit)
      .getRawMany();
    let done = 0;
    for (const row of rows) {
      try {
        const result = await this.deliver(String(row.id), now);
        if (result.claimed) done += 1;
      } catch (error) {
        this.logger.warn(`smena #${row.id} hisoboti: ${short(error)}`);
      }
    }
    return done;
  }

  /** Atomik da'vo: `pending` (yoki eskirgan `processing`) → `processing`. */
  private async claim(
    shiftId: string,
    now: Date,
  ): Promise<{ round: number } | null> {
    const result = await this.dataSource.manager
      .createQueryBuilder()
      .update(Shift)
      .set({ report_status: 'processing', report_claimed_at: now })
      .where('id = :id', { id: shiftId })
      .andWhere('status = :closed', { closed: ShiftStatus.CLOSED })
      .andWhere('is_deleted = false')
      .andWhere(
        `(report_status = 'pending' OR (report_status = 'processing' AND report_claimed_at < :stale))`,
        { stale: new Date(now.getTime() - STALE_PROCESSING_MS) },
      )
      .returning(['report_round'])
      .execute();
    const rows = (Array.isArray(result.raw) ? result.raw : []) as Array<{
      report_round?: number;
    }>;
    if (!rows.length) return null;
    return { round: Math.max(1, Number(rows[0]?.report_round ?? 1)) };
  }

  private async release(shiftId: string, status: 'pending' | 'failed') {
    await this.dataSource.manager
      .createQueryBuilder()
      .update(Shift)
      .set({ report_status: status })
      .where('id = :id', { id: shiftId })
      .andWhere(`report_status = 'processing'`)
      .execute();
  }

  async deliver(
    shiftId: string,
    now: Date = new Date(),
  ): Promise<ShiftReportDeliverResult> {
    const claimed = await this.claim(shiftId, now);
    if (!claimed) return { claimed: false, shift_id: shiftId };
    const round = claimed.round;
    try {
      // Sozlama BIRINCHI: hisobot o'chiq (sukut — hech bir qabul qiluvchi ×
      // kanal yoqilmagan) bo'lsa snapshot / fayl QURILMAYDI — darhol
      // `skipped`. Aks holda qurish xatosi qatorni `pending` ga qaytarib,
      // o'chiq funksiya har daqiqa qayta urinardi.
      const { report } = await this.checks.loadAutomationSettings();
      if (!this.anyRecipientEnabled(report)) {
        return await this.markSkipped(shiftId, round);
      }
      const shift = await this.dataSource.manager.findOne(Shift, {
        where: { id: shiftId },
      });
      if (!shift) throw new NotFoundException('Smena topilmadi');
      const snapshot = await this.buildSnapshot(shift, round);
      const recipients = await this.planRecipients(snapshot, report);
      if (!recipients.length) {
        return await this.markSkipped(shiftId, round);
      }
      // (BOT-2 #3) market ham — egasi shaxsiy Telegram'ga ulanganmi.
      const linked = await this.telegramLinked(
        recipients
          .filter((r) => r.channels.telegram)
          .map((r) => r.recipient_id),
      );
      const fileKey = recipients.some((r) => r.kind === 'superadmin')
        ? await this.storeFile(snapshot, report)
        : null;
      if (fileKey) {
        const superMessage = buildSuperadminMessage(snapshot, fileKey);
        for (const recipient of recipients) {
          if (recipient.kind === 'superadmin') recipient.message = superMessage;
        }
      }
      const type: FinanceNotificationType =
        snapshot.close_reason === 'auto'
          ? 'finance.shift_auto_closed'
          : 'finance.shift_closed';
      let deliveries = 0;
      await this.dataSource.transaction(async (manager) => {
        for (const recipient of recipients) {
          deliveries += await this.enqueueRecipient(
            manager,
            snapshot,
            recipient,
            type,
            linked,
          );
        }
        await manager.update(
          Shift,
          { id: shiftId },
          {
            report_status: 'sent',
            report_file_key: fileKey,
            report_file_format: fileKey ? report.format : null,
          },
        );
      });
      await this.activityLog.log({
        entity_type: 'Shift',
        entity_id: shiftId,
        action:
          round > 1
            ? 'finance.shift_report_resent'
            : 'finance.shift_report_sent',
        new_value: {
          round,
          recipients: recipients.length,
          deliveries,
          close_reason: snapshot.close_reason,
          file_format: fileKey ? report.format : null,
        },
        metadata: {
          superadmins: recipients.filter((r) => r.kind === 'superadmin').length,
          couriers: recipients.filter((r) => r.kind === 'courier').length,
          markets: recipients.filter((r) => r.kind === 'market').length,
        },
        user_id: null,
      });
      return {
        claimed: true,
        shift_id: shiftId,
        round,
        status: 'sent',
        recipients: recipients.length,
        file_key: fileKey,
      };
    } catch (error) {
      // Qayta urinish — scheduler keyingi daqiqada oladi.
      await this.release(shiftId, 'pending').catch(() => undefined);
      throw error;
    }
  }

  /**
   * Kamida bitta qabul qiluvchi guruhida kamida bitta kanal yoqilganmi
   * (`planRecipients` bilan bir xil shart).
   */
  private anyRecipientEnabled(report: ReportSettings): boolean {
    const groups = report?.recipients;
    return [groups?.superadmin, groups?.couriers, groups?.markets].some(
      (channels?: ReportChannels) =>
        Boolean(channels?.in_app || channels?.telegram),
    );
  }

  /** Yuboriladigan hech kim yo'q — `skipped` (outbox / fayl yo'q, qayta urinilmaydi). */
  private async markSkipped(
    shiftId: string,
    round: number,
  ): Promise<ShiftReportDeliverResult> {
    await this.dataSource.manager.update(
      Shift,
      { id: shiftId },
      { report_status: 'skipped' },
    );
    return {
      claimed: true,
      shift_id: shiftId,
      round,
      status: 'skipped',
      recipients: 0,
    };
  }

  /**
   * Bitta qabul qiluvchi: kanal holatlari (`shift_report_deliveries`) + bitta
   * bildirishnoma (outbox). Telegram so'ralgan-u ulanmagan —
   * `failed` + «Telegram ulanmagan», faqat tizim orqali.
   */
  private async enqueueRecipient(
    manager: EntityManager,
    snapshot: ShiftReportSnapshot,
    recipient: PlannedRecipient,
    type: FinanceNotificationType,
    linked: Map<string, boolean> | null,
  ): Promise<number> {
    const entry = findNotificationType(type);
    if (!entry) return 0;
    const dispatchId = deterministicUuid(
      `shift-report:${snapshot.shift_id}:${snapshot.round}:${recipient.recipient_id}`,
    );
    const rows: Array<{
      channel: ShiftReportChannel;
      status: ShiftReportDeliveryStatus;
      failed_reason: string | null;
    }> = [];
    const channels: string[] = [];
    if (recipient.channels.in_app) {
      channels.push(NotificationChannel.IN_APP, NotificationChannel.REALTIME);
      rows.push({ channel: 'in_app', status: 'queued', failed_reason: null });
    }
    let telegram: FinanceNotificationPayload['telegram'];
    if (recipient.channels.telegram) {
      if (
        recipient.kind === 'market' &&
        linked?.get(recipient.recipient_id) === true
      ) {
        /**
         * (BOT-2 #3, ega sukut qarori Q1 = A) Pul faqat SHAXSIY chatga:
         * market egasi Telegram'ga ulangan — to'liq hisobot (summa, usul,
         * karta, qoldiq) unga, guruhga HECH NARSA.
         */
        channels.push(NotificationChannel.TELEGRAM);
        rows.push({
          channel: 'telegram',
          status: 'queued',
          failed_reason: null,
        });
      } else if (recipient.kind === 'market') {
        // Egasi ulanmagan (yoki holat noma'lum) — GURUHGA faqat summasiz
        // «Smena yakunlandi — kabinetda ko'ring» (`group_text`).
        channels.push(NotificationChannel.TELEGRAM);
        // Asosiy (`create`) guruh — market ikki guruhga ulangan bo'lsa ham
        // bitta xabar.
        telegram = {
          market_id: recipient.recipient_id,
          group_type: 'create',
          text: recipient.message.group_text ?? recipient.message.body,
        };
        rows.push({
          channel: 'telegram_group',
          status: 'queued',
          failed_reason: null,
        });
      } else if (linked && linked.get(recipient.recipient_id) === false) {
        rows.push({
          channel: 'telegram',
          status: 'failed',
          failed_reason: deliveryReasonText('telegram_not_linked'),
        });
      } else {
        channels.push(NotificationChannel.TELEGRAM);
        rows.push({
          channel: 'telegram',
          status: 'queued',
          failed_reason: null,
        });
      }
    }
    // Tizim o'chiq + Telegram ulanmagan — dispatch yo'q (faqat holat yoziladi).
    const dispatch = channels.length > 0;
    let written = 0;
    for (const row of rows) {
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(ShiftReportDelivery)
        .values({
          shift_id: snapshot.shift_id,
          round: snapshot.round,
          recipient_id: recipient.recipient_id,
          recipient_kind: recipient.kind,
          channel: row.channel,
          status: row.status,
          failed_reason: row.failed_reason,
          dispatch_id: dispatch ? dispatchId : null,
          notification_type: type,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      written += Array.isArray(result.raw) ? result.raw.length : 0;
    }
    // Qatorlar allaqachon bor (eskirgan `processing` qayta da'vo qilingan,
    // birinchi urinish ham commit bo'lgan) — outbox qayta yozilmaydi.
    if (!dispatch || written === 0) return written;
    const data = { ...recipient.message.data };
    const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
    await this.notifications.shiftReport(
      {
        type,
        category: entry.category,
        priority: entry.priority,
        title: recipient.message.title,
        body: recipient.message.body,
        data,
        link: recipient.message.link,
        recipient_ids: [recipient.recipient_id],
        ...(groupKey ? { group_key: groupKey } : {}),
        channels,
        client_request_id: dispatchId,
        ...(telegram ? { telegram } : {}),
      },
      manager,
    );
    return written;
  }

  // ───────────────────────── snapshot ─────────────────────────

  async buildSnapshot(
    shift: Shift,
    round: number,
  ): Promise<ShiftReportSnapshot> {
    const manager = this.dataSource.manager;
    const cashboxUserId = String(shift.cashbox_user_id ?? MAIN_CASHBOX_USER_ID);
    const cashboxType =
      cashboxUserId === MAIN_CASHBOX_USER_ID
        ? Cashbox_type.MAIN
        : Cashbox_type.BRANCH;
    const to = shift.closed_at ?? new Date();
    const window = (qb: ReturnType<EntityManager['createQueryBuilder']>) =>
      qb
        .innerJoin(Cashbox, 'cb', 'cb.id = h.cashbox_id')
        .where('h.isDeleted = false')
        .andWhere('cb.isDeleted = false')
        .andWhere('cb.user_id = :ownerId', { ownerId: cashboxUserId })
        .andWhere('cb.cashbox_type = :cbType', { cbType: cashboxType })
        .andWhere('h.createdAt BETWEEN :from AND :to', {
          from: shift.opened_at,
          to,
        });

    // Kuryer → kassa topshiruvlari (smena kassasiga KIRIM, courier_payment).
    const courierRows = await window(
      manager.createQueryBuilder(CashboxHistory, 'h'),
    )
      .select('h.source_user_id', 'user_id')
      // (T6) soni — shu smena oynasida qaytarilmagan to'lovlar (qaytarish
      // keyingi smenada bo'lsa bu hisobotda sanaladi); summa — yalpi
      // (oynadagi qaytarilgan qism pastda alohida ayiriladi).
      .addSelect(
        `COUNT(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM ${manager.connection.getMetadata(CashboxHistory).tablePath} r
            WHERE r.reverses_history_id = h.id AND r.is_deleted = false
              AND r."createdAt" BETWEEN :from AND :to))`,
        'count',
      )
      .addSelect('COALESCE(SUM(h.amount), 0)', 'total')
      .andWhere('h.operation_type = :income', {
        income: Operation_type.INCOME,
      })
      .andWhere('h.source_type = :courier', {
        courier: Source_type.COURIER_PAYMENT,
      })
      .andWhere('h.source_user_id IS NOT NULL')
      .groupBy('h.source_user_id')
      .getRawMany<{ user_id: string; count: string; total: string }>();

    // Kassa → market to'lovlari (smena kassasidan CHIQIM, market_payment).
    const marketRows = await window(
      manager.createQueryBuilder(CashboxHistory, 'h'),
    )
      .select('h.id', 'id')
      .addSelect('h.source_user_id', 'user_id')
      .addSelect('h.amount', 'amount')
      .addSelect('h.payment_method', 'payment_method')
      .addSelect('h.card_id', 'card_id')
      .addSelect('h.createdAt', 'at')
      .andWhere('h.operation_type = :expense', {
        expense: Operation_type.EXPENSE,
      })
      .andWhere('h.source_type = :market', {
        market: Source_type.MARKET_PAYMENT,
      })
      .andWhere('h.source_user_id IS NOT NULL')
      .orderBy('h.createdAt', 'ASC')
      .addOrderBy('h.id', 'ASC')
      .getRawMany<{
        id: string;
        user_id: string;
        amount: string;
        payment_method: string;
        card_id: string | null;
        at: Date;
      }>();

    /**
     * (T6) Shu smenada QAYTARILGAN to'lovlar — teskari qatorlar
     * (`payment_reversal`) asl oyoq turi bo'yicha: kuryer topshirig'i
     * (asl INCOME `courier_payment`) kuryer jamidan ayiriladi; market
     * to'lovi (asl EXPENSE `market_payment`) — manfiy «qaytarildi» qatori.
     * Shunda hisobot qatorlari smena jamiga mos keladi.
     */
    const reversalRows = await window(
      manager.createQueryBuilder(CashboxHistory, 'h'),
    )
      .innerJoin(CashboxHistory, 'o', 'o.id = h.reverses_history_id')
      .select('h.id', 'id')
      .addSelect('h.source_user_id', 'user_id')
      .addSelect('h.amount', 'amount')
      .addSelect('h.payment_method', 'payment_method')
      .addSelect('h.card_id', 'card_id')
      .addSelect('h.createdAt', 'at')
      .addSelect('o.source_type', 'original_source')
      .andWhere('h.source_type = :reversal', {
        reversal: Source_type.PAYMENT_REVERSAL,
      })
      .andWhere('h.source_user_id IS NOT NULL')
      .andWhere('o.source_type IN (:...originals)', {
        originals: [Source_type.COURIER_PAYMENT, Source_type.MARKET_PAYMENT],
      })
      .orderBy('h.createdAt', 'ASC')
      .addOrderBy('h.id', 'ASC')
      .getRawMany<{
        id: string;
        user_id: string;
        amount: string;
        payment_method: string;
        card_id: string | null;
        at: Date;
        original_source: string;
      }>();
    const courierReversed = new Map<string, number>();
    for (const row of reversalRows) {
      if (row.original_source !== String(Source_type.COURIER_PAYMENT)) continue;
      const id = String(row.user_id);
      courierReversed.set(
        id,
        Math.round(
          ((courierReversed.get(id) ?? 0) + (num(row.amount) ?? 0)) * 100,
        ) / 100,
      );
      if (!courierRows.some((r) => String(r.user_id) === id)) {
        courierRows.push({ user_id: id, count: '0', total: '0' });
      }
    }
    for (const row of reversalRows) {
      if (row.original_source !== String(Source_type.MARKET_PAYMENT)) continue;
      marketRows.push({ ...row, amount: String(-(num(row.amount) ?? 0)) });
    }
    marketRows.sort(
      (a, b) =>
        new Date(a.at).getTime() - new Date(b.at).getTime() ||
        Number(a.id) - Number(b.id),
    );
    const reversedMarketIds = new Set(
      reversalRows
        .filter(
          (row) => row.original_source === String(Source_type.MARKET_PAYMENT),
        )
        .map((row) => String(row.id)),
    );

    const courierIds = courierRows.map((row) => String(row.user_id));
    const marketIds = [
      ...new Set(marketRows.map((row) => String(row.user_id))),
    ];
    const balances = await this.cashboxBalances(courierIds, marketIds);
    const cardIds = [
      ...new Set(
        marketRows
          .map((row) => row.card_id)
          .filter((id): id is string => id != null)
          .map(String),
      ),
    ];
    const cards = cardIds.length
      ? await manager.find(CashboxCard, { where: { id: In(cardIds) } })
      : [];
    const cardName = new Map(
      cards.map((card) => [
        String(card.id),
        `${card.name}${card.last4 ? ` •${card.last4}` : ''}`,
      ]),
    );
    const names = await this.userNames([
      ...courierIds,
      ...marketIds,
      ...[shift.opened_by, shift.closed_by]
        .filter((id) => id != null)
        .map(String),
    ]);

    const couriers: CourierSlice[] = courierRows
      .map((row) => {
        const reversed = courierReversed.get(String(row.user_id)) ?? 0;
        const received = num(row.total) ?? 0;
        return {
          courier_id: String(row.user_id),
          name: names.get(String(row.user_id)) ?? null,
          count: Number(row.count) || 0,
          total: Math.round((received - reversed) * 100) / 100,
          ...(reversed > 0 ? { received, reversed } : {}),
          remaining_debt: balances.couriers.get(String(row.user_id)) ?? null,
        };
      })
      .filter(
        (slice) =>
          slice.count > 0 ||
          (slice.reversed ?? 0) > 0 ||
          (slice.received ?? slice.total) > 0,
      );

    const marketMap = new Map<string, MarketSlice>();
    for (const row of marketRows) {
      const id = String(row.user_id);
      const slice = marketMap.get(id) ?? {
        market_id: id,
        name: names.get(id) ?? null,
        payments: [],
        total: 0,
        balance: balances.markets.get(id) ?? null,
      };
      const amount = num(row.amount) ?? 0;
      slice.payments.push({
        history_id: String(row.id),
        amount,
        payment_method: String(row.payment_method),
        card_name: row.card_id
          ? (cardName.get(String(row.card_id)) ?? null)
          : null,
        at: row.at,
        ...(reversedMarketIds.has(String(row.id)) ? { reversed: true } : {}),
      });
      slice.total = Math.round((slice.total + amount) * 100) / 100;
      marketMap.set(id, slice);
    }

    const accountRows = await this.checks.listForShift(String(shift.id));
    const block = (kind: 'cash' | 'card'): ShiftMoneyBlock => ({
      opening_balance: num(shift[`opening_balance_${kind}`]),
      total_income: num(shift[`total_income_${kind}`]),
      total_expense: num(shift[`total_expense_${kind}`]),
      expected_balance: num(shift[`expected_balance_${kind}`]),
      closing_balance: num(shift[`closing_balance_${kind}`]),
      discrepancy: num(shift[`discrepancy_${kind}`]),
    });
    return {
      shift_id: String(shift.id),
      round,
      cashbox_type: cashboxUserId === MAIN_CASHBOX_USER_ID ? 'main' : 'branch',
      cashbox_user_id: cashboxUserId,
      opened_at: shift.opened_at,
      closed_at: shift.closed_at,
      opened_by: shift.opened_by != null ? String(shift.opened_by) : null,
      opened_by_name: names.get(String(shift.opened_by)) ?? null,
      closed_by: shift.closed_by != null ? String(shift.closed_by) : null,
      closed_by_name:
        shift.closed_by != null
          ? (names.get(String(shift.closed_by)) ?? null)
          : null,
      close_reason: shift.close_reason === 'auto' ? 'auto' : 'manual',
      cash: block('cash'),
      card: block('card'),
      accounts: accountRows.map((row) => {
        const card = row.card as {
          name?: string;
          last4?: string | null;
        } | null;
        return {
          card_id: String(row.card_id),
          name: card?.name ?? `#${String(row.card_id)}`,
          last4: card?.last4 ?? null,
          expected_balance: num(row.expected_balance),
          entered_balance: num(row.entered_balance),
          difference: num(row.difference),
          ai_status: String(row.ai_status),
        };
      }),
      couriers,
      markets: [...marketMap.values()],
    };
  }

  private async cashboxBalances(
    courierIds: string[],
    marketIds: string[],
  ): Promise<{ couriers: Map<string, number>; markets: Map<string, number> }> {
    const couriers = new Map<string, number>();
    const markets = new Map<string, number>();
    const load = async (
      ids: string[],
      type: Cashbox_type,
      into: Map<string, number>,
    ) => {
      if (!ids.length) return;
      const rows = await this.dataSource.manager.find(Cashbox, {
        where: { user_id: In(ids), cashbox_type: type, isDeleted: false },
      });
      for (const row of rows) {
        const value = num(row.balance);
        if (value != null) into.set(String(row.user_id), value);
      }
    };
    await load(courierIds, Cashbox_type.FOR_COURIER, couriers);
    await load(marketIds, Cashbox_type.FOR_MARKET, markets);
    return { couriers, markets };
  }

  /** `identity.user.find_by_ids` — fail-open (ism yo'q bo'lsa `#id`). */
  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(isId))];
    const names = new Map<string, string>();
    if (!unique.length) return names;
    try {
      const response = await rmqSend<{ data?: unknown }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        { ids: unique },
        { timeoutMs: 5_000, retries: 1 },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows as Array<{ id?: unknown; name?: unknown }>) {
        const id =
          typeof row?.id === 'string' || typeof row?.id === 'number'
            ? String(row.id)
            : '';
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        if (id && name) names.set(id, name.slice(0, 80));
      }
    } catch (error) {
      this.logger.warn(`hisobot: ismlar olinmadi — ${short(error)}`);
    }
    return names;
  }

  // ───────────────────────── qabul qiluvchilar ─────────────────────────

  private async planRecipients(
    snapshot: ShiftReportSnapshot,
    report: ReportSettings,
  ): Promise<PlannedRecipient[]> {
    const enabled = (channels: ReportChannels) =>
      channels.in_app || channels.telegram;
    const planned: PlannedRecipient[] = [];
    if (enabled(report.recipients.superadmin)) {
      const message = buildSuperadminMessage(snapshot, null);
      for (const id of await this.superadminIds()) {
        planned.push({
          kind: 'superadmin',
          recipient_id: id,
          message,
          channels: report.recipients.superadmin,
        });
      }
    }
    if (enabled(report.recipients.couriers)) {
      for (const slice of snapshot.couriers) {
        planned.push({
          kind: 'courier',
          recipient_id: slice.courier_id,
          message: buildCourierMessage(snapshot, slice),
          channels: report.recipients.couriers,
        });
      }
    }
    if (enabled(report.recipients.markets)) {
      for (const slice of snapshot.markets) {
        planned.push({
          kind: 'market',
          recipient_id: slice.market_id,
          message: buildMarketMessage(
            snapshot,
            slice,
            process.env.ELCHI_CABINET_URL || undefined,
          ),
          channels: report.recipients.markets,
        });
      }
    }
    return planned;
  }

  /**
   * Faol superadminlar (aniq `recipient_ids` — rol/broadcast EMAS). Identity
   * javob bermasa — XATO (da'vo bo'shatiladi, keyingi tick qayta uradi):
   * superadminsiz "yuborildi" deb yozilmasin.
   */
  private async superadminIds(): Promise<string[]> {
    const response = await rmqSend<{ data?: unknown }>(
      this.identityClient,
      { cmd: IDENTITY_ACTIVE_BY_ROLE_PATTERN },
      { role: 'superadmin' },
      { timeoutMs: 5_000, retries: 1 },
    );
    const rows = Array.isArray(response?.data) ? response.data : null;
    if (!rows)
      throw new Error(`${IDENTITY_ACTIVE_BY_ROLE_PATTERN}: javob yaroqsiz`);
    return [
      ...new Set(
        (rows as Array<{ user_id?: unknown; id?: unknown }>)
          .map((row) => text(row?.user_id ?? row?.id))
          .filter(isId),
      ),
    ];
  }

  /**
   * Shaxsiy Telegram ulanganmi (`identity.telegram.resolve_many`). Xato —
   * `null` (holat `queued`, notification-service o'zi `no_telegram_id` deb
   * yozadi; ro'yxat o'qilganda sinxronlanadi).
   */
  private async telegramLinked(
    userIds: string[],
  ): Promise<Map<string, boolean> | null> {
    const ids = [...new Set(userIds.filter(isId))];
    if (!ids.length) return new Map();
    try {
      const response = await rmqSend<{ data?: Record<string, unknown> }>(
        this.identityClient,
        { cmd: 'identity.telegram.resolve_many' },
        { user_ids: ids },
        { timeoutMs: 5_000, retries: 1 },
      );
      const data = response?.data;
      if (!data || typeof data !== 'object') return null;
      return new Map(
        ids.map((id) => [id, /^\d{1,20}$/.test(text(data[id]).trim())]),
      );
    } catch (error) {
      this.logger.warn(`hisobot: telegram holati olinmadi — ${short(error)}`);
      return null;
    }
  }

  /** Fayl → file-service (`shift-report`, private). Xato — ilovasiz davom. */
  private async storeFile(
    snapshot: ShiftReportSnapshot,
    report: ReportSettings,
  ): Promise<string | null> {
    if (!this.fileClient) return null;
    try {
      const buffer = await buildReportFile(snapshot, report.format);
      const response = await rmqSend<{ data?: { key?: unknown } }>(
        this.fileClient,
        { cmd: 'file.upload' },
        {
          file_name: reportFileName(snapshot.shift_id, report.format),
          mime_type: REPORT_MIME[report.format],
          file_base64: buffer.toString('base64'),
          folder: 'shift-report',
          // (dgvwZasd B) Tizim yaratadi — yuklovchi foydalanuvchi yo'q.
          owner: { id: 'system', role: 'system', branch_id: null },
        },
        { timeoutMs: 20_000, retries: 1 },
      );
      const key = response?.data?.key;
      return typeof key === 'string' && key ? key : null;
    } catch (error) {
      this.logger.warn(
        `smena #${snapshot.shift_id} hisobot fayli saqlanmadi: ${short(error)}`,
      );
      return null;
    }
  }

  // ───────────────────────── API ─────────────────────────

  /**
   * «Hisobot kimlarga yuborildi» ro'yxati. `dispatch_id` — gateway shu bilan
   * notification-service'dan haqiqiy holatni o'qib, `applyDeliveryStatuses`
   * orqali qaytaradi (finance NOTIFICATION mijozini ishlatmaydi — faqat outbox).
   */
  async listDeliveries(
    shiftId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.dataSource.getRepository(ShiftReportDelivery).find({
      where: { shift_id: shiftId, isDeleted: false },
      order: { round: 'DESC', recipient_kind: 'ASC', id: 'ASC' },
    });
    const names = await this.userNames(rows.map((row) => row.recipient_id));
    return rows.map((row) => ({
      id: String(row.id),
      round: row.round,
      recipient_id: String(row.recipient_id),
      recipient_name: names.get(String(row.recipient_id)) ?? null,
      recipient_kind: row.recipient_kind,
      channel: row.channel,
      status: row.status,
      failed_reason: row.failed_reason,
      dispatch_id: row.dispatch_id,
      sent_at: row.sent_at,
      created_at: row.createdAt,
    }));
  }

  /**
   * Gateway notification-service'dan o'qigan `delivery` holatlari → faqat
   * shu smenaning `queued` qatorlari yangilanadi (boshqa smena / allaqachon
   * yakunlangan qator o'zgarmaydi). Qaytadi — yangilangan ro'yxat.
   */
  async applyDeliveryStatuses(input: { shift_id?: unknown; found?: unknown }) {
    try {
      const shiftId = text(input?.shift_id).trim();
      if (!isId(shiftId)) throw new BadRequestException("shift_id noto'g'ri");
      const found = (Array.isArray(input?.found) ? input.found : [])
        .slice(0, 1000)
        .map((item) => (item ?? {}) as Record<string, unknown>);
      const byKey = new Map<string, Record<string, unknown>>();
      for (const item of found) {
        const delivery =
          item.delivery && typeof item.delivery === 'object'
            ? (item.delivery as Record<string, unknown>)
            : {};
        byKey.set(
          `${text(item.dispatch_id).toLowerCase()}:${text(item.recipient_id)}`,
          delivery,
        );
      }
      const repo = this.dataSource.getRepository(ShiftReportDelivery);
      const queued = byKey.size
        ? await repo.find({
            where: { shift_id: shiftId, status: 'queued', isDeleted: false },
          })
        : [];
      let updated = 0;
      for (const row of queued) {
        if (!row.dispatch_id) continue;
        const delivery = byKey.get(
          `${String(row.dispatch_id).toLowerCase()}:${String(row.recipient_id)}`,
        );
        if (!delivery) continue;
        const next = deliveryStatusFrom(row.channel, delivery);
        if (!next || next.status === 'queued') continue;
        const result = await repo.update(
          { id: row.id, status: 'queued' },
          {
            status: next.status,
            failed_reason: next.failed_reason,
            sent_at: next.status === 'sent' ? new Date() : null,
          },
        );
        updated += Number(result.affected ?? 0);
      }
      return {
        statusCode: 200,
        message: 'Shift report deliveries synced',
        data: { updated, deliveries: await this.listDeliveries(shiftId) },
      };
    } catch (error) {
      toRpcError(error);
    }
  }

  /** `POST finance/shift/:id/report/resend` — faqat SUPERADMIN; yangi raund. */
  async resend(input: {
    shift_id?: unknown;
    requester_id?: unknown;
    requester_roles?: unknown;
  }) {
    try {
      const roles = Array.isArray(input?.requester_roles)
        ? input.requester_roles.map((role) => String(role).toLowerCase())
        : [];
      if (!roles.includes('superadmin')) {
        forbidden('Smena hisobotini faqat superadmin qayta yuboradi');
      }
      const shiftId = text(input?.shift_id).trim();
      if (!isId(shiftId)) throw new BadRequestException("shift_id noto'g'ri");
      const result = await this.dataSource.manager
        .createQueryBuilder()
        .update(Shift)
        .set({
          report_round: () => 'GREATEST("report_round", 0) + 1',
          report_status: 'pending',
        })
        .where('id = :id', { id: shiftId })
        .andWhere('status = :closed', { closed: ShiftStatus.CLOSED })
        .andWhere('is_deleted = false')
        .andWhere(`(report_status IS NULL OR report_status <> 'processing')`)
        .returning(['report_round'])
        .execute();
      const rows = (Array.isArray(result.raw) ? result.raw : []) as unknown[];
      if (!Array.isArray(rows) || !rows.length) {
        const shift = await this.dataSource.manager.findOne(Shift, {
          where: { id: shiftId, isDeleted: false },
        });
        if (!shift) throw new NotFoundException('Smena topilmadi');
        if (shift.status !== ShiftStatus.CLOSED) {
          throw new BadRequestException('Smena hali yopilmagan');
        }
        throw new BadRequestException(
          "Hisobot hozir yuborilmoqda — birozdan keyin qayta urinib ko'ring",
        );
      }
      const outcome = await this.deliver(shiftId);
      const deliveries = await this.listDeliveries(shiftId);
      return {
        statusCode: 200,
        message: 'Shift report resent',
        data: {
          shift_id: shiftId,
          round: outcome.round ?? null,
          status: outcome.status ?? null,
          recipients: outcome.recipients ?? 0,
          deliveries,
          requested_by: isId(input?.requester_id)
            ? String(input?.requester_id)
            : null,
        },
      };
    } catch (error) {
      toRpcError(error);
    }
  }
}

/** notification-service `delivery` JSONB → yetkazish qatori holati. */
export function deliveryStatusFrom(
  channel: ShiftReportChannel,
  delivery: Record<string, unknown>,
): { status: ShiftReportDeliveryStatus; failed_reason: string | null } | null {
  if (channel === 'in_app') {
    return { status: 'sent', failed_reason: null };
  }
  const status = text(delivery.telegram);
  const reason = text(delivery.telegram_reason ?? delivery.telegram_error);
  switch (status) {
    case 'sent':
      return { status: 'sent', failed_reason: null };
    case 'failed':
      return { status: 'failed', failed_reason: deliveryReasonText(reason) };
    case 'skipped':
    case 'not_eligible':
      return {
        status: 'failed',
        failed_reason: deliveryReasonText(
          reason || (channel === 'telegram_group' ? 'no_telegram_group' : ''),
        ),
      };
    case 'no_provider':
      return {
        status: 'failed',
        failed_reason: deliveryReasonText('no_provider'),
      };
    default:
      return { status: 'queued', failed_reason: null };
  }
}
