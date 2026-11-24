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
  buildBranchMessage,
  buildBranchSliceMessage,
  buildCourierMessage,
  buildMarketMessage,
  buildSuperadminMessage,
  deliveryReasonText,
  type CourierSlice,
  type MarketSlice,
  type ShiftMoneyBlock,
  type BranchSlice,
  type ShiftReportMessage,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import {
  REPORT_MIME,
  branchReportFileName,
  buildBranchSliceXlsx,
  buildMarketXlsx,
  buildReportFile,
  marketReportFileName,
  reportFileName,
} from './shift-report.file';

const MAIN_CASHBOX_USER_ID = '0';
/** `processing` shundan eski bo'lsa (replika yiqilgan) — qayta da'vo qilinadi. */
const STALE_PROCESSING_MS = 10 * 60_000;
/** `pending` smena shuncha turgandan keyin scheduler oladi (deliverSoon ulgurmasa). */
const PENDING_GRACE_MS = 30_000;

export const IDENTITY_ACTIVE_BY_ROLE_PATTERN =
  'identity.user.active_ids_by_role';
/** notification-service — filial kassasi hisoboti qayerga (guruh / shaxsiy). */
export const BRANCH_TELEGRAM_ROUTE_PATTERN =
  'notification.telegram.branch_route';
export const BRANCH_TELEGRAM_ROUTES_PATTERN =
  'notification.telegram.branch_routes';
/** `branch.find_all` sahifasi (servis chegarasi — 100). */
const BRANCH_PAGE_LIMIT = 100;
/** branch-service `branch.find_by_id` / `find_by_branch` — tizim nomidan. */
const SYSTEM_BRANCH_REQUESTER = { id: 'system', roles: ['superadmin'] };

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
  message: ShiftReportMessage & { group_text?: string; telegram_text?: string };
  channels: ReportChannels;
  /**
   * `branch` (filial guruhi) — dispatch kimlar nomidan (inbox qatori):
   * filial menejerlari → smenani yopgan / ochgan xodim → superadminlar
   * (`branchNotifyIds`).
   */
  notify_ids?: string[];
  /**
   * Asosiy kassa smenasi — filialning FAQAT O'Z bo'lagi: to'liq hisobot
   * Excel'i bu qabul qiluvchiga HECH QACHON biriktirilmaydi (faqat o'ziniki).
   */
  slice?: BranchSlice;
  /** `branch` — guruh holati (`telegram` so'ralganda); yo'q — ulanmagan. */
  group?: { active: boolean; inactive_reason: string | null };
  /**
   * (audit 2026-11-22 #3) `branch` — hisobotni yuborib bo'lmaydi (dispatch
   * qiladigan faol foydalanuvchi yo'q / filial marshruti olinmadi). So'ralgan
   * kanallar `failed` + shu sabab bilan yoziladi, dispatch YO'Q — hisobot
   * izsiz yo'qolmaydi, «Hisobot kimlarga yuborildi» blokida ko'rinadi.
   */
  unreachable?: {
    reason: string;
    channel: Extract<ShiftReportChannel, 'telegram' | 'telegram_group'>;
  };
}

export interface BranchTelegramRoute {
  report_target: 'group' | 'private';
  group: { active: boolean; inactive_reason: string | null } | null;
}

/** (audit #3) Yuborib bo'lmaydigan filial hisoboti — faqat `failed` holat. */
function unreachableBranch(
  branchId: string,
  message: ShiftReportMessage,
  channels: ReportChannels,
  reason: string,
  channel: NonNullable<PlannedRecipient['unreachable']>['channel'],
): PlannedRecipient {
  return {
    kind: 'branch',
    recipient_id: branchId,
    message,
    channels,
    unreachable: { reason, channel },
  };
}

/** Hisobot manzili sozlangan filial (`notification.telegram.branch_routes`). */
export interface BranchTelegramRouteRow extends BranchTelegramRoute {
  branch_id: string;
}

const reportNotificationType = (
  snapshot: Pick<ShiftReportSnapshot, 'close_reason'>,
): FinanceNotificationType =>
  snapshot.close_reason === 'auto'
    ? 'finance.shift_auto_closed'
    : 'finance.shift_closed';

/** Filialga Telegram guruhi umuman ulanmagan (`route.group = null`). */
const BRANCH_GROUP_NOT_LINKED = 'branch_group_not_linked';

/** Xabarga Telegram ilovasini (file-service kaliti) qo'shadi — yangi obyekt. */
function withExcel<T extends ShiftReportMessage>(
  message: T,
  key: string,
  caption: string,
): T {
  return {
    ...message,
    data: {
      ...message.data,
      telegram_media: [key],
      telegram_media_caption: caption,
    },
  };
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
    @Optional()
    @Inject('NOTIFICATION')
    private readonly notificationClient?: ClientProxy,
    @Optional() @Inject('BRANCH') private readonly branchClient?: ClientProxy,
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
      // Yagona qabul qiluvchi — guruhi ulanmagan filial: hech narsa ketmaydi
      // (`skipped`), lekin sababi «Hisobot kimlarga yuborildi» da ko'rinadi.
      if (
        recipients.every(
          (r) => r.unreachable?.reason === BRANCH_GROUP_NOT_LINKED,
        )
      ) {
        return await this.markSkipped(shiftId, round, snapshot, recipients);
      }
      // (BOT-2 #3) market ham — egasi shaxsiy Telegram'ga ulanganmi.
      // `branch` — filial id (foydalanuvchi emas), guruhga ketadi.
      const linked = await this.telegramLinked(
        recipients
          .filter((r) => r.channels.telegram && r.kind !== 'branch')
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
      await this.attachExcel(snapshot, report, recipients, linked, fileKey);
      const type = reportNotificationType(snapshot);
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
          branch_groups: recipients.filter((r) => r.kind === 'branch').length,
          branch_managers: recipients.filter((r) => r.kind === 'branch_manager')
            .length,
          branch_slices: new Set(
            recipients.filter((r) => r.slice).map((r) => r.slice!.branch_id),
          ).size,
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
    return [
      groups?.superadmin,
      groups?.couriers,
      groups?.markets,
      groups?.branches,
    ].some((channels?: ReportChannels) =>
      Boolean(channels?.in_app || channels?.telegram),
    );
  }

  /**
   * Yuboriladigan hech kim yo'q — `skipped` (outbox / fayl yo'q, qayta
   * urinilmaydi). `unreachable` qabul qiluvchilar berilsa — sababi bilan
   * `failed` qatorlari ham shu tranzaksiyada yoziladi.
   */
  private async markSkipped(
    shiftId: string,
    round: number,
    snapshot?: ShiftReportSnapshot,
    unreachable: PlannedRecipient[] = [],
  ): Promise<ShiftReportDeliverResult> {
    const patch = { report_status: 'skipped' as const };
    if (snapshot && unreachable.length) {
      const type = reportNotificationType(snapshot);
      await this.dataSource.transaction(async (manager) => {
        for (const recipient of unreachable) {
          await this.enqueueRecipient(manager, snapshot, recipient, type, null);
        }
        await manager.update(Shift, { id: shiftId }, patch);
      });
    } else {
      await this.dataSource.manager.update(Shift, { id: shiftId }, patch);
    }
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
    // Filial id foydalanuvchi id bilan bir xil son bo'lishi mumkin — nomlar fazosi.
    const dispatchId = deterministicUuid(
      recipient.kind === 'branch'
        ? `shift-report:${snapshot.shift_id}:${snapshot.round}:branch:${recipient.recipient_id}`
        : `shift-report:${snapshot.shift_id}:${snapshot.round}:${recipient.recipient_id}`,
    );
    const rows: Array<{
      channel: ShiftReportChannel;
      status: ShiftReportDeliveryStatus;
      failed_reason: string | null;
    }> = [];
    if (recipient.unreachable) {
      // (audit #3) Yuborib bo'lmaydi — faqat holat (`failed` + sabab), dispatch yo'q.
      const failed_reason = deliveryReasonText(recipient.unreachable.reason);
      if (recipient.channels.in_app) {
        rows.push({ channel: 'in_app', status: 'failed', failed_reason });
      }
      if (recipient.channels.telegram) {
        rows.push({
          channel: recipient.unreachable.channel,
          status: 'failed',
          failed_reason,
        });
      }
      return this.insertDeliveryRows(manager, snapshot, recipient, type, rows);
    }
    const channels: string[] = [];
    if (recipient.channels.in_app) {
      channels.push(NotificationChannel.IN_APP, NotificationChannel.REALTIME);
      rows.push({ channel: 'in_app', status: 'queued', failed_reason: null });
    }
    let telegram: FinanceNotificationPayload['telegram'];
    if (recipient.channels.telegram && recipient.kind === 'branch') {
      // Filial kassasi GURUHI — to'liq hisobot (menejer guruh ulab rozi bo'lgan).
      if (recipient.group?.active) {
        channels.push(NotificationChannel.TELEGRAM);
        telegram = {
          branch_id: recipient.recipient_id,
          text: recipient.message.telegram_text ?? recipient.message.body,
        };
        rows.push({
          channel: 'telegram_group',
          status: 'queued',
          failed_reason: null,
        });
      } else {
        rows.push({
          channel: 'telegram_group',
          status: 'failed',
          failed_reason: deliveryReasonText(
            recipient.group ? 'branch_group_inactive' : BRANCH_GROUP_NOT_LINKED,
          ),
        });
      }
    } else if (recipient.channels.telegram) {
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
    const written = await this.insertDeliveryRows(
      manager,
      snapshot,
      recipient,
      type,
      rows,
      dispatch ? dispatchId : null,
    );
    // Qatorlar allaqachon bor (eskirgan `processing` qayta da'vo qilingan,
    // birinchi urinish ham commit bo'lgan) — outbox qayta yozilmaydi.
    if (!dispatch || written === 0) return written;
    const data = { ...recipient.message.data };
    const baseGroupKey = renderNotificationGroupKey(
      entry.group_key_pattern,
      data,
    );
    // (audit #16) Filial guruhi dispatch'i — O'Z kaliti. Umumiy kalitda
    // (`finance:shift:{id}:report:{round}`) notification-service qatorni
    // `recipient_id + group_key` bo'yicha yangilaydi: HQ smenasini superadmin
    // yopsa (notify = closed_by), uning shaxsiy hisobot qatori filial xabari
    // bilan almashib, `dispatch_id` o'zgarardi va superadmin yetkazishlari
    // «Hisobot kimlarga yuborildi» blokida abadiy `queued` qolardi.
    const groupKey =
      baseGroupKey && recipient.kind === 'branch'
        ? `${baseGroupKey}:branch:${recipient.recipient_id}`
        : baseGroupKey;
    await this.notifications.shiftReport(
      {
        type,
        category: entry.category,
        priority: entry.priority,
        title: recipient.message.title,
        body: recipient.message.body,
        data,
        link: recipient.message.link,
        recipient_ids: recipient.notify_ids?.length
          ? recipient.notify_ids
          : [recipient.recipient_id],
        ...(groupKey ? { group_key: groupKey } : {}),
        channels,
        client_request_id: dispatchId,
        ...(telegram ? { telegram } : {}),
      },
      manager,
    );
    return written;
  }

  /** `shift_report_deliveries` qatorlari (takror — `orIgnore`). Yozilganlar soni. */
  private async insertDeliveryRows(
    manager: EntityManager,
    snapshot: ShiftReportSnapshot,
    recipient: PlannedRecipient,
    type: FinanceNotificationType,
    rows: Array<{
      channel: ShiftReportChannel;
      status: ShiftReportDeliveryStatus;
      failed_reason: string | null;
    }>,
    dispatchId: string | null = null,
  ): Promise<number> {
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
          dispatch_id: dispatchId,
          notification_type: type,
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      written += Array.isArray(result.raw) ? result.raw.length : 0;
    }
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

    const branches =
      cashboxType === Cashbox_type.MAIN
        ? await this.branchTransfers(window)
        : null;

    const accountRows = await this.checks.listForShift(String(shift.id), shift);
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
      ...(branches ? { branches } : {}),
      between_shifts: await this.betweenShifts(
        shift,
        cashboxUserId,
        cashboxType,
      ),
    };
  }

  /**
   * Asosiy kassa smenasi oynasida FILIALLARDAN kelgan pul (`branch_to_main`
   * KIRIM; `source_user_id` — filial id) va shu oynada qaytarilganlari (manfiy
   * «qaytarildi» qatori). `payment_reversal` faqat asl oyoq `branch_to_main`
   * KIRIM bo'lsa olinadi: `source_user_id` foydalanuvchi va filial id'larini
   * aralash saqlaydi.
   */
  private async branchTransfers(
    window: (
      qb: ReturnType<EntityManager['createQueryBuilder']>,
    ) => ReturnType<EntityManager['createQueryBuilder']>,
  ): Promise<BranchSlice[]> {
    const manager = this.dataSource.manager;
    type Row = {
      id: string;
      branch_id: string;
      amount: string;
      payment_method: string;
      at: Date;
    };
    const columns = (qb: ReturnType<EntityManager['createQueryBuilder']>) =>
      qb
        .select('h.id', 'id')
        .addSelect('h.source_user_id', 'branch_id')
        .addSelect('h.amount', 'amount')
        .addSelect('h.payment_method', 'payment_method')
        .addSelect('h.createdAt', 'at')
        .andWhere('h.source_user_id IS NOT NULL');
    const [received, reversed] = await Promise.all([
      columns(window(manager.createQueryBuilder(CashboxHistory, 'h')))
        .andWhere('h.operation_type = :income', {
          income: Operation_type.INCOME,
        })
        .andWhere('h.source_type = :branchToMain', {
          branchToMain: Source_type.BRANCH_TO_MAIN,
        })
        .getRawMany<Row>(),
      columns(
        window(manager.createQueryBuilder(CashboxHistory, 'h')).innerJoin(
          CashboxHistory,
          'o',
          'o.id = h.reverses_history_id',
        ),
      )
        .andWhere('h.source_type = :reversal', {
          reversal: Source_type.PAYMENT_REVERSAL,
        })
        .andWhere('o.source_type = :branchToMain', {
          branchToMain: Source_type.BRANCH_TO_MAIN,
        })
        .andWhere('o.operation_type = :income', {
          income: Operation_type.INCOME,
        })
        .getRawMany<Row>(),
    ]);
    const lines = [
      ...received.map((row) => ({ row, reversed: false })),
      ...reversed.map((row) => ({ row, reversed: true })),
    ].sort(
      (a, b) =>
        new Date(a.row.at).getTime() - new Date(b.row.at).getTime() ||
        Number(a.row.id) - Number(b.row.id),
    );
    if (!lines.length) return [];
    const ids = [...new Set(lines.map(({ row }) => String(row.branch_id)))];
    const [directory, balances] = await Promise.all([
      this.branchDirectory(),
      this.branchBalances(ids),
    ]);
    const slices = new Map<string, BranchSlice>();
    for (const { row, reversed: isReversal } of lines) {
      const id = String(row.branch_id);
      const slice = slices.get(id) ?? {
        branch_id: id,
        name: directory?.get(id) ?? null,
        payments: [],
        total: 0,
        balance: balances.get(id) ?? null,
      };
      const amount = (num(row.amount) ?? 0) * (isReversal ? -1 : 1);
      slice.payments.push({
        history_id: String(row.id),
        amount,
        payment_method: String(row.payment_method),
        at: row.at,
        ...(isReversal ? { reversed: true } : {}),
      });
      slice.total = Math.round((slice.total + amount) * 100) / 100;
      slices.set(id, slice);
    }
    return [...slices.values()];
  }

  /** Filial kassalaridagi joriy qoldiq (`cashboxes.user_id` — filial id). */
  private async branchBalances(ids: string[]): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    if (!ids.length) return balances;
    const rows = await this.dataSource.manager.find(Cashbox, {
      where: {
        user_id: In(ids),
        cashbox_type: Cashbox_type.BRANCH,
        isDeleted: false,
      },
    });
    for (const row of rows) {
      const value = num(row.balance);
      if (value != null) balances.set(String(row.user_id), value);
    }
    return balances;
  }

  /**
   * Oldingi smena yopilgandan shu smena ochilguncha (SMENASIZ) shu kassadagi
   * pul harakati — hech qaysi smenaning kirim/chiqimiga kirmaydi, faqat shu
   * smenaning ochilish qoldig'ida ko'rinadi. Hisobotda alohida ko'rsatiladi.
   * Oldingi smena yo'q yoki harakat yo'q — `null`. Faqat o'qish.
   */
  private async betweenShifts(
    shift: Shift,
    cashboxUserId: string,
    cashboxType: Cashbox_type,
  ): Promise<ShiftReportSnapshot['between_shifts']> {
    const manager = this.dataSource.manager;
    const previous = await manager
      .createQueryBuilder(Shift, 's')
      .select(['s.id', 's.closed_at'])
      .where('s.isDeleted = false')
      .andWhere('s.status = :closed', { closed: ShiftStatus.CLOSED })
      .andWhere('s.id <> :id', { id: shift.id })
      .andWhere('s.closed_at <= :openedAt', { openedAt: shift.opened_at })
      .andWhere(
        cashboxUserId === MAIN_CASHBOX_USER_ID
          ? "(s.cashbox_user_id = '0' OR s.cashbox_user_id IS NULL)"
          : 's.cashbox_user_id = :cashbox',
        { cashbox: cashboxUserId },
      )
      .orderBy('s.closed_at', 'DESC')
      .limit(1)
      .getOne();
    if (!previous?.closed_at) return null;
    const row = await manager
      .createQueryBuilder(CashboxHistory, 'h')
      .innerJoin(Cashbox, 'cb', 'cb.id = h.cashbox_id')
      .select(
        `COALESCE(SUM(h.amount) FILTER (WHERE h.operation_type = :income), 0)`,
        'income',
      )
      .addSelect(
        `COALESCE(SUM(h.amount) FILTER (WHERE h.operation_type = :expense), 0)`,
        'expense',
      )
      .addSelect('COUNT(*)', 'count')
      .where('h.isDeleted = false')
      .andWhere('cb.isDeleted = false')
      .andWhere('cb.user_id = :ownerId', { ownerId: cashboxUserId })
      .andWhere('cb.cashbox_type = :cbType', { cbType: cashboxType })
      .andWhere('h.createdAt > :from AND h.createdAt < :to', {
        from: previous.closed_at,
        to: shift.opened_at,
      })
      .setParameters({
        income: Operation_type.INCOME,
        expense: Operation_type.EXPENSE,
      })
      .getRawOne<{ income: string; expense: string; count: string }>();
    const count = Number(row?.count ?? 0);
    if (!count) return null;
    return {
      from: previous.closed_at,
      to: shift.opened_at,
      income: num(row?.income) ?? 0,
      expense: num(row?.expense) ?? 0,
      count,
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
    if (enabled(report.recipients.branches)) {
      planned.push(
        ...(await this.planBranchRecipients(
          snapshot,
          report.recipients.branches,
        )),
        ...(await this.planBranchSlices(snapshot, report.recipients.branches)),
      );
    }
    return planned;
  }

  /**
   * ASOSIY kassa smenasi yopildi → hisobot manzili sozlangan HAR filialga
   * (HQ'dan tashqari) FAQAT O'Z bo'lagi: HQ'ga topshirgan puli va o'z kassasi
   * qoldig'i (ega 2026-11-25: filial smenasi yopilishini kutmaydi). Manzil —
   * filial sozlamasi: guruh yoki `private` (menejerlar). Ulanmagan filial —
   * ro'yxatda yo'q (qator ham yozilmaydi); nofaol guruh — `failed` + sabab.
   *
   * Fail-soft: manzillar / HQ olinmasa — faqat WARN, HQ va superadmin hisoboti
   * kechikmaydi («Hisobotni qayta yuborish» bilan qayta urinish mumkin).
   */
  private async planBranchSlices(
    snapshot: ShiftReportSnapshot,
    channels: ReportChannels,
  ): Promise<PlannedRecipient[]> {
    if (snapshot.cashbox_type !== 'main' || !channels.telegram) return [];
    if (!this.notificationClient || !this.branchClient) return [];
    try {
      const routes = await this.branchRoutes();
      if (!routes.length) return [];
      const [hqId, directory] = await Promise.all([
        this.hqBranchId(),
        this.branchDirectory(),
      ]);
      // HQ noma'lum — uning guruhiga «filial bo'lagi» ketib qolmasin.
      if (!isId(hqId)) throw new Error('HQ filiali topilmadi');
      // O'chirilgan filial — ro'yxatda yo'q (ro'yxat olinmasa filtrsiz).
      const targets = routes.filter(
        (route) =>
          route.branch_id !== hqId &&
          (!directory || directory.has(route.branch_id)) &&
          (route.report_target === 'private' || route.group),
      );
      const balances = await this.branchBalances(
        targets.map((route) => route.branch_id),
      );
      const planned: PlannedRecipient[] = [];
      for (const route of targets) {
        const own = snapshot.branches?.find(
          (item) => item.branch_id === route.branch_id,
        );
        const slice: BranchSlice = {
          branch_id: route.branch_id,
          name: directory?.get(route.branch_id) ?? own?.name ?? null,
          payments: own?.payments ?? [],
          total: own?.total ?? 0,
          balance: balances.get(route.branch_id) ?? null,
        };
        planned.push(
          ...(await this.planBranchSlice(snapshot, route, slice, channels)),
        );
      }
      return planned;
    } catch (error) {
      this.logger.warn(
        `smena #${snapshot.shift_id}: filiallarga o'z hisoboti yuborilmadi — ${short(error)}`,
      );
      return [];
    }
  }

  private async planBranchSlice(
    snapshot: ShiftReportSnapshot,
    route: BranchTelegramRouteRow,
    slice: BranchSlice,
    channels: ReportChannels,
  ): Promise<PlannedRecipient[]> {
    const message = buildBranchSliceMessage(
      snapshot,
      slice,
      process.env.ELCHI_CABINET_URL || undefined,
    );
    const isPrivate = route.report_target === 'private';
    const failed = (reason: string): PlannedRecipient[] => [
      {
        ...unreachableBranch(
          slice.branch_id,
          message,
          { telegram: true, in_app: false },
          reason,
          isPrivate ? 'telegram' : 'telegram_group',
        ),
        slice,
      },
    ];
    let managers: string[] = [];
    try {
      managers = await this.activeUserIds(
        await this.branchManagerIds(slice.branch_id),
      );
    } catch (error) {
      this.logger.warn(
        `filial #${slice.branch_id} menejerlari olinmadi: ${short(error)}`,
      );
      if (isPrivate) return failed('branch_report_unavailable');
    }
    if (isPrivate) {
      if (!managers.length) return failed('branch_no_managers');
      return managers.map((id) => ({
        kind: 'branch_manager' as const,
        recipient_id: id,
        message,
        channels: { telegram: true, in_app: channels.in_app },
        slice,
      }));
    }
    // Menejersiz filial: dispatch smenani yopgan xodim nomidan — ilova ichida
    // unga begona filial xabari yozilmasin (faqat guruhga).
    const notify = managers.length
      ? managers
      : await this.branchNotifyIds(snapshot, []);
    if (!notify.length) return failed('no_report_recipient');
    return [
      {
        kind: 'branch',
        recipient_id: slice.branch_id,
        notify_ids: notify,
        message,
        channels: {
          telegram: true,
          in_app: channels.in_app && managers.length > 0,
        },
        ...(route.group ? { group: route.group } : {}),
        slice,
      },
    ];
  }

  /**
   * Filial kassasi hisoboti (asosiy kassa — HQ filiali):
   *  - telegram + filial `group` + guruh bor → bitta `branch` qatori (guruhga;
   *    nofaol guruh — `failed` + sabab);
   *  - telegram + filial `private` → har menejerga `branch_manager` (shaxsiy
   *    chat, ulanmagan — «Telegram ulanmagan»);
   *  - telegram + filial `group` + guruh ULANMAGAN → `failed` qatori «Filial
   *    guruhi ulanmagan» (prod 2026-11-25: bot guruhga qo'shilgan, lekin
   *    ulanmagan — hisobot sababsiz `skipped` bo'lib, ega sababini ko'rmagan);
   *  - in_app → menejerlarga ilova ichida.
   *
   * (audit 2026-11-22 #3) Sozlangan hisobot JIM YO'QOLMAYDI: guruh dispatch'i
   * uchun faol foydalanuvchi bo'lmasa, `private` da faol menejer bo'lmasa
   * (HQ'da menejer bo'lmaydi) yoki asosiy kassada marshrut olinmasa —
   * `unreachable` qatori (`failed` + sabab).
   *
   * Filial kassasida marshrut / menejerlar olinmasa — XATO (da'vo
   * bo'shatiladi, keyingi tick qayta uradi). Asosiy kassada esa fail-soft:
   * mavjud superadmin hisoboti yangi bog'liqlik sabab kechikmasin.
   */
  private async planBranchRecipients(
    snapshot: ShiftReportSnapshot,
    channels: ReportChannels,
  ): Promise<PlannedRecipient[]> {
    const isMain = snapshot.cashbox_type === 'main';
    // Mijozlar ulanmagan (test / qisman o'rnatish) — filial qismi jim o'tadi.
    if (!this.notificationClient || !this.branchClient) return [];
    let branchId = '';
    let wantPrivate = false;
    try {
      branchId = isMain
        ? await this.hqBranchId()
        : String(snapshot.cashbox_user_id);
      if (!isId(branchId)) return [];
      const route = channels.telegram ? await this.branchRoute(branchId) : null;
      wantPrivate = Boolean(
        channels.telegram && route?.report_target === 'private',
      );
      const wantGroup = Boolean(
        channels.telegram && route && route.report_target !== 'private',
      );
      if (!wantPrivate && !wantGroup && !channels.in_app) return [];
      // Faqat guruh so'ralgan, u esa ulanmagan — nom / menejerlar kerak emas.
      if (wantGroup && !route?.group && !channels.in_app) {
        return [
          unreachableBranch(
            branchId,
            buildBranchMessage(
              snapshot,
              null,
              process.env.ELCHI_CABINET_URL || undefined,
            ),
            { telegram: true, in_app: false },
            BRANCH_GROUP_NOT_LINKED,
            'telegram_group',
          ),
        ];
      }
      const [branchName, managers] = await Promise.all([
        this.branchName(branchId),
        wantPrivate
          ? this.branchManagerIds(branchId)
          : this.branchManagerIds(branchId).catch((error) => {
              this.logger.warn(
                `filial #${branchId} menejerlari olinmadi: ${short(error)}`,
              );
              return [] as string[];
            }),
      ]);
      const message = buildBranchMessage(
        snapshot,
        branchName,
        process.env.ELCHI_CABINET_URL || undefined,
      );
      if (wantPrivate) {
        // O'chirilgan menejer id'si bilan dispatch 400 — outbox qatori
        // yiqilib, yetkazish abadiy `queued` qolardi.
        const active = await this.activeUserIds(managers);
        if (!active.length) {
          return [
            unreachableBranch(
              branchId,
              message,
              { telegram: true, in_app: channels.in_app },
              'branch_no_managers',
              'telegram',
            ),
          ];
        }
        return active.map((id) => ({
          kind: 'branch_manager' as const,
          recipient_id: id,
          message,
          channels: { telegram: true, in_app: channels.in_app },
        }));
      }
      const reportChannels = { telegram: wantGroup, in_app: channels.in_app };
      const notify = await this.branchNotifyIds(snapshot, managers);
      if (!notify.length) {
        return [
          unreachableBranch(
            branchId,
            message,
            reportChannels,
            'no_report_recipient',
            'telegram_group',
          ),
        ];
      }
      return [
        {
          kind: 'branch',
          recipient_id: branchId,
          notify_ids: notify,
          message,
          channels: reportChannels,
          ...(wantGroup && route?.group ? { group: route.group } : {}),
        },
      ];
    } catch (error) {
      if (!isMain) throw error;
      this.logger.warn(
        `smena #${snapshot.shift_id}: asosiy kassa filial hisoboti yuborilmadi — ${short(error)}`,
      );
      // HQ ma'lum — jim emas: «Hisobot kimlarga yuborildi» da `failed`.
      if (!isId(branchId)) return [];
      return [
        unreachableBranch(
          branchId,
          buildBranchMessage(
            snapshot,
            null,
            process.env.ELCHI_CABINET_URL || undefined,
          ),
          { telegram: channels.telegram, in_app: channels.in_app },
          'branch_report_unavailable',
          wantPrivate ? 'telegram' : 'telegram_group',
        ),
      ];
    }
  }

  /**
   * Filial guruhi dispatch'i kimlar nomidan. notification-service
   * qabul qiluvchisiz dispatch'ni 400 bilan rad etadi, guruh relay'i esa
   * faqat dispatch ichida navbatga qo'yiladi — ro'yxat bo'sh bo'lsa guruhga
   * hech narsa ketmasdi. Tartib: faol menejerlar → smenani yopgan / ochgan
   * xodim → faol superadminlar (HQ'ga menejer biriktirilmaydi, avto-smenada
   * yopgan / ochgan yo'q). Har bosqich identity'dagi mavjudlik bo'yicha
   * filtrlanadi (o'chirilgan id bilan dispatch 400 bo'lmasin).
   * Superadminlar olinmasa — XATO (filial kassasi qayta uradi).
   */
  private async branchNotifyIds(
    snapshot: ShiftReportSnapshot,
    managers: string[],
  ): Promise<string[]> {
    const staff = await this.activeUserIds(managers);
    if (staff.length) return staff;
    const actors = await this.activeUserIds([
      snapshot.closed_by,
      snapshot.opened_by,
    ]);
    if (actors.length) return actors;
    return this.superadminIds();
  }

  /**
   * Identity'da mavjud (o'chirilmagan) foydalanuvchilar — notification-service
   * dispatch'i ham aynan shu shart bilan tekshiradi. Identity javob bermasa —
   * filtrsiz (fail-open, avvalgi xatti-harakat).
   */
  private async activeUserIds(
    ids: Array<string | null | undefined>,
  ): Promise<string[]> {
    const unique = [...new Set(ids.filter(isId).map(String))];
    if (!unique.length) return [];
    try {
      const response = await rmqSend<{ data?: unknown }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        { ids: unique },
        { timeoutMs: 5_000, retries: 1 },
      );
      const rows = Array.isArray(response?.data) ? response.data : null;
      if (!rows) return unique;
      const found = new Set(
        (rows as Array<{ id?: unknown }>).map((row) => text(row?.id)),
      );
      return unique.filter((id) => found.has(id));
    } catch (error) {
      this.logger.warn(
        `hisobot: foydalanuvchilar tekshirilmadi — ${short(error)}`,
      );
      return unique;
    }
  }

  /** HQ filiali (asosiy kassa egasi). Topilmasa — ''. */
  private async hqBranchId(): Promise<string> {
    if (!this.branchClient) return '';
    const response = await rmqSend<{ data?: { id?: unknown } | null }>(
      this.branchClient,
      { cmd: 'branch.find_hq' },
      {},
      { timeoutMs: 5_000, retries: 1 },
    );
    return text(response?.data?.id);
  }

  /** notification-service: filial hisoboti qayerga. Xato — throw. */
  async branchRoute(branchId: string): Promise<BranchTelegramRoute> {
    if (!this.notificationClient) {
      throw new Error('NOTIFICATION mijozi yo‘q');
    }
    const response = await rmqSend<{ data?: Record<string, unknown> | null }>(
      this.notificationClient,
      { cmd: BRANCH_TELEGRAM_ROUTE_PATTERN },
      { branch_id: branchId },
      { timeoutMs: 5_000, retries: 1 },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
      throw new Error(`${BRANCH_TELEGRAM_ROUTE_PATTERN}: javob yaroqsiz`);
    }
    const group =
      data.group && typeof data.group === 'object'
        ? (data.group as Record<string, unknown>)
        : null;
    return {
      report_target: data.report_target === 'private' ? 'private' : 'group',
      group: group
        ? {
            active: group.active === true,
            inactive_reason: text(group.inactive_reason) || null,
          }
        : null,
    };
  }

  /** notification-service: hisobot manzili sozlangan filiallar. Xato — throw. */
  async branchRoutes(): Promise<BranchTelegramRouteRow[]> {
    if (!this.notificationClient) {
      throw new Error('NOTIFICATION mijozi yo‘q');
    }
    const response = await rmqSend<{ data?: unknown }>(
      this.notificationClient,
      { cmd: BRANCH_TELEGRAM_ROUTES_PATTERN },
      {},
      { timeoutMs: 5_000, retries: 1 },
    );
    if (!Array.isArray(response?.data)) {
      throw new Error(`${BRANCH_TELEGRAM_ROUTES_PATTERN}: javob yaroqsiz`);
    }
    return (response.data as Array<Record<string, unknown>>)
      .filter((row) => row && isId(row.branch_id))
      .map((row) => {
        const group =
          row.group && typeof row.group === 'object'
            ? (row.group as Record<string, unknown>)
            : null;
        return {
          branch_id: text(row.branch_id),
          report_target:
            row.report_target === 'private'
              ? ('private' as const)
              : ('group' as const),
          group: group
            ? {
                active: group.active === true,
                inactive_reason: text(group.inactive_reason) || null,
              }
            : null,
        };
      });
  }

  /** Hamma (o'chirilmagan) filial nomlari. Olinmasa — `null` (fail-open). */
  private async branchDirectory(): Promise<Map<string, string> | null> {
    if (!this.branchClient) return null;
    try {
      const names = new Map<string, string>();
      for (let page = 1; page <= 10; page += 1) {
        const response = await rmqSend<{ data?: { items?: unknown } | null }>(
          this.branchClient,
          { cmd: 'branch.find_all' },
          {
            query: { page, limit: BRANCH_PAGE_LIMIT },
            requester: SYSTEM_BRANCH_REQUESTER,
          },
          { timeoutMs: 5_000, retries: 1 },
        );
        const items = response?.data?.items;
        if (!Array.isArray(items)) return null;
        for (const item of items as Array<Record<string, unknown>>) {
          const id = text(item?.id);
          if (isId(id)) names.set(id, text(item.name).trim().slice(0, 80));
        }
        if (items.length < BRANCH_PAGE_LIMIT) return names;
      }
      return names;
    } catch (error) {
      this.logger.warn(`filiallar ro'yxati olinmadi: ${short(error)}`);
      return null;
    }
  }

  /** Filial nomi — fail-open (`null`). */
  private async branchName(branchId: string): Promise<string | null> {
    if (!this.branchClient) return null;
    try {
      const response = await rmqSend<{ data?: { name?: unknown } | null }>(
        this.branchClient,
        { cmd: 'branch.find_by_id' },
        { id: branchId, requester: SYSTEM_BRANCH_REQUESTER },
        { timeoutMs: 3_000, retries: 0 },
      );
      const name = text(response?.data?.name).trim();
      return name ? name.slice(0, 80) : null;
    } catch (error) {
      this.logger.warn(`filial #${branchId} nomi olinmadi: ${short(error)}`);
      return null;
    }
  }

  /** Filialning faol menejerlari (`branch_users.role = MANAGER`). Xato — throw. */
  private async branchManagerIds(branchId: string): Promise<string[]> {
    if (!this.branchClient) throw new Error('BRANCH mijozi yo‘q');
    const response = await rmqSend<{ data?: unknown }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: branchId, requester: SYSTEM_BRANCH_REQUESTER },
      { timeoutMs: 5_000, retries: 1 },
    );
    const rows = Array.isArray(response?.data) ? response.data : null;
    if (!rows) throw new Error('branch.user.find_by_branch: javob yaroqsiz');
    return [
      ...new Set(
        (rows as Array<Record<string, unknown>>)
          .filter(
            (row) =>
              row &&
              row.isDeleted !== true &&
              text(row.role).toUpperCase() === 'MANAGER',
          )
          .map((row) => text(row.user_id))
          .filter(isId),
      ),
    ];
  }

  /**
   * «Kun tartibi» — kechikish xabari ham shu ro'yxatga yuboriladi
   * (`ShiftAutoCloseScheduler`). Identity javob bermasa — XATO.
   */
  activeSuperadminIds(): Promise<string[]> {
    return this.superadminIds();
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
  /**
   * Xabar + EXCEL: Telegram'ga ketadigan qabul qiluvchilarga XLSX ilova.
   *  - filial guruhi (faol) va filial menejerlari (shaxsiy chat) — to'liq
   *    hisobot (shu kassa; asosiy kassa — HQ filiali); superadmin fayli XLSX
   *    bo'lsa o'sha kalit qayta ishlatiladi;
   *  - filial bo'lagi (`slice`, asosiy kassa smenasi) — FAQAT o'z HQ
   *    to'lovlari Excel'i; to'liq hisobot unga HECH QACHON ketmaydi;
   *  - market — egasi Telegram'ga ulangan (shaxsiy chat) bo'lsa, FAQAT o'z
   *    to'lovlari Excel'i. Ulanmagan market guruhiga — summasiz xabar, fayl
   *    YO'Q (BOT-2 #3).
   * Fayl saqlanmasa — xabar baribir ketadi (fail-soft).
   */
  private async attachExcel(
    snapshot: ShiftReportSnapshot,
    report: ReportSettings,
    recipients: PlannedRecipient[],
    linked: Map<string, boolean> | null,
    superFileKey: string | null,
  ): Promise<void> {
    const toBranch = recipients.filter(
      (r) =>
        r.channels.telegram &&
        ((r.kind === 'branch' && r.group?.active) ||
          r.kind === 'branch_manager'),
    );
    const sliceKeys = new Map<string, string | null>();
    for (const recipient of toBranch) {
      const { slice } = recipient;
      if (!slice?.payments.length) continue;
      let key = sliceKeys.get(slice.branch_id);
      if (key === undefined) {
        key = await this.storeBuffer(
          snapshot.shift_id,
          () => buildBranchSliceXlsx(snapshot, slice),
          branchReportFileName(snapshot.shift_id, slice.branch_id),
          REPORT_MIME.xlsx,
        );
        sliceKeys.set(slice.branch_id, key);
      }
      if (key) {
        recipient.message = withExcel(
          recipient.message,
          key,
          "📎 HQ'ga topshirilgan (Excel)",
        );
      }
    }
    const wantsFull = toBranch.filter((r) => !r.slice);
    if (wantsFull.length) {
      const key =
        superFileKey && report.format === 'xlsx'
          ? superFileKey
          : await this.storeBuffer(
              snapshot.shift_id,
              () => buildReportFile(snapshot, 'xlsx'),
              reportFileName(snapshot.shift_id, 'xlsx'),
              REPORT_MIME.xlsx,
            );
      if (key) {
        for (const recipient of wantsFull) {
          recipient.message = withExcel(
            recipient.message,
            key,
            "📎 To'liq hisobot (Excel)",
          );
        }
      }
    }
    for (const recipient of recipients) {
      if (
        recipient.kind !== 'market' ||
        !recipient.channels.telegram ||
        linked?.get(recipient.recipient_id) !== true
      ) {
        continue;
      }
      const slice = snapshot.markets.find(
        (item) => item.market_id === recipient.recipient_id,
      );
      if (!slice) continue;
      const key = await this.storeBuffer(
        snapshot.shift_id,
        () => buildMarketXlsx(snapshot, slice),
        marketReportFileName(snapshot.shift_id, slice.market_id),
        REPORT_MIME.xlsx,
      );
      if (key) {
        recipient.message = withExcel(
          recipient.message,
          key,
          "📎 Sizga to'lovlar (Excel)",
        );
      }
    }
  }

  private storeFile(
    snapshot: ShiftReportSnapshot,
    report: ReportSettings,
  ): Promise<string | null> {
    return this.storeBuffer(
      snapshot.shift_id,
      () => buildReportFile(snapshot, report.format),
      reportFileName(snapshot.shift_id, report.format),
      REPORT_MIME[report.format],
    );
  }

  /** Fayl → file-service (private, `shift-report`). Xato — `null` (WARN). */
  private async storeBuffer(
    shiftId: string,
    build: () => Promise<Buffer>,
    fileName: string,
    mimeType: string,
  ): Promise<string | null> {
    if (!this.fileClient) return null;
    try {
      const buffer = await build();
      const response = await rmqSend<{ data?: { key?: unknown } }>(
        this.fileClient,
        { cmd: 'file.upload' },
        {
          file_name: fileName,
          mime_type: mimeType,
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
        `smena #${shiftId} hisobot fayli (${fileName}) saqlanmadi: ${short(error)}`,
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
    const isBranch = (row: ShiftReportDelivery) =>
      row.recipient_kind === 'branch';
    const [names, branchNames] = await Promise.all([
      this.userNames(
        rows.filter((row) => !isBranch(row)).map((row) => row.recipient_id),
      ),
      this.branchNames(
        rows.filter(isBranch).map((row) => String(row.recipient_id)),
      ),
    ]);
    return rows.map((row) => ({
      id: String(row.id),
      round: row.round,
      recipient_id: String(row.recipient_id),
      recipient_name:
        (isBranch(row) ? branchNames : names).get(String(row.recipient_id)) ??
        null,
      recipient_kind: row.recipient_kind,
      channel: row.channel,
      status: row.status,
      failed_reason: row.failed_reason,
      dispatch_id: row.dispatch_id,
      sent_at: row.sent_at,
      created_at: row.createdAt,
    }));
  }

  private async branchNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(ids.filter(isId))];
    if (!unique.length) return names;
    // Asosiy kassa hisoboti o'nlab filialga ketadi — bitta so'rov bilan.
    const directory = unique.length > 1 ? await this.branchDirectory() : null;
    for (const id of unique) {
      const known = directory?.get(id);
      if (known) names.set(id, known);
    }
    for (const id of unique.filter((item) => !names.has(item)).slice(0, 20)) {
      const name = await this.branchName(id);
      if (name) names.set(id, name);
    }
    return names;
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
      // Filial guruhi (`branch`): dispatch menejerlar nomidan — guruh relay
      // natijasi hamma qatorda bir xil, dispatch bo'yicha birinchisi olinadi.
      const byDispatch = new Map<string, Record<string, unknown>>();
      for (const item of found) {
        const delivery =
          item.delivery && typeof item.delivery === 'object'
            ? (item.delivery as Record<string, unknown>)
            : {};
        const dispatch = text(item.dispatch_id).toLowerCase();
        byKey.set(`${dispatch}:${text(item.recipient_id)}`, delivery);
        if (!byDispatch.has(dispatch)) byDispatch.set(dispatch, delivery);
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
        const dispatch = String(row.dispatch_id).toLowerCase();
        const delivery =
          row.recipient_kind === 'branch'
            ? byDispatch.get(dispatch)
            : byKey.get(`${dispatch}:${String(row.recipient_id)}`);
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
