import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DataSource } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { ShiftScheduleClaim } from '../entities/shift-schedule-claim.entity';
import {
  FinanceNotificationService,
  type ShiftLateAlertInput,
} from '../notification/finance-notification.service';
import { ShiftAccountCheckService } from '../shift-account-check/shift-account-check.service';
import { ShiftReportService } from '../shift-report/shift-report.service';
import {
  dueCloseSlots,
  dueLateSlots,
  dueWarnSlots,
  lateCloseClaimKey,
  lateOpenClaimKey,
  warnClaimKey,
  type AutoCloseScope,
  type AutoCloseSettings,
  type AutoOpenSettings,
  type LateAlertSettings,
  type ScheduleSlot,
} from './shift-schedule.rules';

const JOB_NAME = 'finance-shift-auto-close';
/** Har daqiqa (sekund maydoni bilan), Asia/Tashkent. */
export const SHIFT_SCHEDULER_CRON = '0 * * * * *';
/**
 * Replikalararo tick qulfi (`pg_try_advisory_lock`). Qulf bandi — shu tick
 * o'tkaziladi. Bu faqat ortiqcha ishni kesadi; TO'G'RILIK kafolati —
 * smena / kassa qatori FOR UPDATE + `shift_schedule_claims` PRIMARY KEY.
 */
export const SHIFT_SCHEDULER_LOCK_KEY = 716_000_000_167;

const MAIN_CASHBOX_USER_ID = '0';
/** `main+branches` qamrovida bir tickda ko'rib chiqiladigan filial kassalari. */
const MAX_SCOPE_CASHBOXES = 500;

export interface ShiftTickResult {
  locked: boolean;
  /** `auto_close.enabled` (avvalgi ma'no). */
  enabled: boolean;
  closed: string[];
  warned: string[];
  reports: number;
  /** «Kun tartibi» — tizim ochgan smenalar. */
  opened: string[];
  /** «Kun tartibi» — yuborilgan kechikish xabarlari (kalitlar). */
  late: string[];
}

/** Bitta tick ichida kechikish xabarini yuboruvchi (superadminlar bir marta o'qiladi). */
interface LateAlerter {
  send(
    claimKey: string,
    shiftId: string | null,
    input: Omit<
      ShiftLateAlertInput,
      'recipient_ids' | 'channels' | 'grace_min'
    >,
  ): Promise<boolean>;
}

/**
 * y8Tqm9Ap — smenani jadval bo'yicha AVTOMATIK yopish (+ ogohlantirish),
 * gWI4gYkw — qolib ketgan smena hisobotlarini yuborish va «Kun tartibi»
 * (2026-11-11) — AVTOMATIK OCHISH hamda KECHIKISH XABARI.
 *
 * Har daqiqa superadmin sozlamasi o'qiladi:
 *  - `auto_close` yoqiq — `warn_before_min` oynasida smenani ochgan xodimga
 *    BIR marta ogohlantirish; slot vaqti kelgan (catch-up 10 daqiqa) —
 *    `opened_at < slot` bo'lgan ochiq smenalar `autoCloseShift` bilan yopiladi;
 *  - `auto_open` yoqiq — slot vaqti kelgan (catch-up 10 daqiqa) qamrovdagi
 *    har kassada ochiq smena yo'q bo'lsa `autoOpenShift` (tizim ochadi);
 *  - `late_alert` yoqiq — ochish slotidan `grace_min` o'tib kassada smena
 *    ochilmagan / yopish slotidan keyin smena hali ochiq bo'lsa superadminlarga
 *    «Smena vaqtida ochilmadi / yopilmadi»; tizimning avtomatik ochishi /
 *    yopishi xato bilan tugasa — darhol, sababi bilan. Kassa / smena × slot
 *    uchun BIR marta (`late_open:` / `late_close:` kaliti + outbox, bitta
 *    tranzaksiya).
 * Qamrov: `main` — faqat asosiy kassa, `main+branches` — filiallar ham.
 *
 * `FINANCE_SHIFT_SCHEDULER=off` — cron umuman ishga tushmaydi (favqulodda).
 */
@Injectable()
export class ShiftAutoCloseScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShiftAutoCloseScheduler.name);
  private job?: CronJob;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly finance: FinanceServiceService,
    private readonly checks: ShiftAccountCheckService,
    private readonly notifications: FinanceNotificationService,
    private readonly reports: ShiftReportService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly registry?: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const flag = String(
      this.config?.get<string>('FINANCE_SHIFT_SCHEDULER') ?? '',
    )
      .trim()
      .toLowerCase();
    if (flag === 'off' || flag === 'false' || flag === '0') {
      this.logger.warn("FINANCE_SHIFT_SCHEDULER=off — smena jadvali o'chiq");
      return;
    }
    this.job = CronJob.from({
      cronTime: SHIFT_SCHEDULER_CRON,
      onTick: () => void this.tick(),
      start: false,
      timeZone: 'Asia/Tashkent',
    });
    try {
      this.registry?.addCronJob(JOB_NAME, this.job as never);
    } catch {
      // allaqachon ro'yxatda (hot reload)
    }
    this.job.start();
  }

  onModuleDestroy(): void {
    try {
      if (this.job) void this.job.stop();
    } catch {
      // allaqachon to'xtagan
    }
  }

  async tick(now: Date = new Date()): Promise<ShiftTickResult> {
    const result: ShiftTickResult = {
      locked: false,
      enabled: false,
      closed: [],
      warned: [],
      reports: 0,
      opened: [],
      late: [],
    };
    if (this.running) return result;
    this.running = true;
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows: Array<{ ok?: boolean }> = await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS ok',
        [SHIFT_SCHEDULER_LOCK_KEY],
      );
      locked = rows?.[0]?.ok === true;
      if (!locked) return result;
      result.locked = true;
      const { auto_close, auto_open, late_alert } =
        await this.checks.loadAutomationSettings();
      result.enabled = auto_close.enabled;
      const alerter = late_alert.enabled
        ? this.lateAlerter(late_alert, result.late)
        : null;
      if (auto_close.enabled && auto_close.times.length) {
        result.warned = await this.warn(now, auto_close);
        result.closed = await this.close(now, auto_close, alerter);
      }
      if (auto_open.enabled && auto_open.times.length) {
        result.opened = await this.open(now, auto_open, alerter);
      }
      if (alerter) {
        await this.lateChecks(now, auto_open, auto_close, late_alert, alerter);
      }
      result.reports = await this.reports.processPending(now);
    } catch (error) {
      this.logger.error(
        `smena jadvali tick xatosi: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock($1::bigint)', [
            SHIFT_SCHEDULER_LOCK_KEY,
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
      this.running = false;
    }
    return result;
  }

  /** Qamrovdagi, slotdan OLDIN ochilgan ochiq smenalar. */
  private async openShifts(
    settings: { scope: AutoCloseScope },
    before: Date,
  ): Promise<Shift[]> {
    const qb = this.dataSource.manager
      .createQueryBuilder(Shift, 's')
      .where('s.status = :open', { open: ShiftStatus.OPEN })
      .andWhere('s.isDeleted = false')
      .andWhere('s.opened_at < :before', { before });
    if (settings.scope === 'main') {
      qb.andWhere("(s.cashbox_user_id = '0' OR s.cashbox_user_id IS NULL)");
    }
    return qb.orderBy('s.id', 'ASC').limit(500).getMany();
  }

  /** Qamrovdagi kassalar: `'0'` (asosiy) + `main+branches` da filial kassalari. */
  private async scopeCashboxes(scope: AutoCloseScope): Promise<string[]> {
    if (scope === 'main') return [MAIN_CASHBOX_USER_ID];
    const branches = await this.dataSource.manager.find(Cashbox, {
      where: { cashbox_type: Cashbox_type.BRANCH, isDeleted: false },
      select: { id: true, user_id: true },
      order: { id: 'ASC' },
      take: MAX_SCOPE_CASHBOXES,
    });
    const ids = branches
      .map((row) => String(row.user_id ?? '').trim())
      .filter((id) => /^\d+$/.test(id) && id !== MAIN_CASHBOX_USER_ID);
    return [MAIN_CASHBOX_USER_ID, ...new Set(ids)];
  }

  /**
   * Ochish slotidan beri kassada smena bo'lganmi: hozir ochiq smena bor YOKI
   * slotdan keyin ochilgan (allaqachon yopilgan bo'lsa ham) smena bor.
   */
  private async openedSince(
    cashboxUserId: string,
    slotAt: Date,
  ): Promise<boolean> {
    const qb = this.dataSource.manager
      .createQueryBuilder(Shift, 's')
      .where('s.isDeleted = false')
      .andWhere('(s.status = :open OR s.opened_at >= :slot)', {
        open: ShiftStatus.OPEN,
        slot: slotAt,
      });
    if (cashboxUserId === MAIN_CASHBOX_USER_ID) {
      qb.andWhere("(s.cashbox_user_id = '0' OR s.cashbox_user_id IS NULL)");
    } else {
      qb.andWhere('s.cashbox_user_id = :cashbox', { cashbox: cashboxUserId });
    }
    return (await qb.getCount()) > 0;
  }

  private async close(
    now: Date,
    settings: AutoCloseSettings,
    alerter: LateAlerter | null,
  ): Promise<string[]> {
    const closed: string[] = [];
    for (const slot of dueCloseSlots(now, settings.times)) {
      for (const shift of await this.openShifts(settings, slot.at)) {
        try {
          const outcome = await this.finance.autoCloseShift({
            shift_id: String(shift.id),
            slot_key: slot.key,
            slot_at: slot.at,
          });
          if (outcome.closed) {
            closed.push(String(shift.id));
            this.logger.log(
              `smena #${shift.id} avtomatik yopildi (slot ${slot.key})`,
            );
          }
        } catch (error) {
          const reason = errorText(error);
          this.logger.error(
            `smena #${shift.id} avtomatik yopilmadi (slot ${slot.key}): ${reason}`,
          );
          await alerter
            ?.send(
              lateCloseClaimKey(String(shift.id), slot.key),
              String(shift.id),
              {
                kind: 'close',
                cashbox_user_id: String(
                  shift.cashbox_user_id ?? MAIN_CASHBOX_USER_ID,
                ),
                shift_id: String(shift.id),
                slot: slot.key,
                time: slot.time,
                reason,
              },
            )
            .catch(() => false);
        }
      }
    }
    return closed;
  }

  private async open(
    now: Date,
    settings: AutoOpenSettings,
    alerter: LateAlerter | null,
  ): Promise<string[]> {
    const opened: string[] = [];
    const slots = dueCloseSlots(now, settings.times);
    if (!slots.length) return opened;
    const cashboxes = await this.scopeCashboxes(settings.scope);
    for (const slot of slots) {
      for (const cashboxUserId of cashboxes) {
        try {
          const outcome = await this.finance.autoOpenShift({
            cashbox_user_id: cashboxUserId,
            slot_key: slot.key,
            slot_at: slot.at,
          });
          if (outcome.opened && outcome.shift_id) {
            opened.push(outcome.shift_id);
            this.logger.log(
              `kassa ${cashboxUserId}: smena #${outcome.shift_id} avtomatik ochildi (slot ${slot.key})`,
            );
          }
        } catch (error) {
          const reason = errorText(error);
          this.logger.error(
            `kassa ${cashboxUserId}: smena avtomatik ochilmadi (slot ${slot.key}): ${reason}`,
          );
          await alerter
            ?.send(lateOpenClaimKey(cashboxUserId, slot.key), null, {
              kind: 'open',
              cashbox_user_id: cashboxUserId,
              shift_id: null,
              slot: slot.key,
              time: slot.time,
              reason,
            })
            .catch(() => false);
        }
      }
    }
    return opened;
  }

  /** Ochish va yopish slotlaridan `grace_min` o'tgach holatni tekshiradi. */
  private async lateChecks(
    now: Date,
    autoOpen: AutoOpenSettings,
    autoClose: AutoCloseSettings,
    late: LateAlertSettings,
    alerter: LateAlerter,
  ): Promise<void> {
    const openSlots = dueLateSlots(now, autoOpen.times, late.grace_min);
    if (openSlots.length) {
      const cashboxes = await this.scopeCashboxes(autoOpen.scope);
      for (const slot of openSlots) {
        for (const cashboxUserId of cashboxes) {
          try {
            if (await this.openedSince(cashboxUserId, slot.at)) continue;
            await alerter.send(
              lateOpenClaimKey(cashboxUserId, slot.key),
              null,
              {
                kind: 'open',
                cashbox_user_id: cashboxUserId,
                shift_id: null,
                slot: slot.key,
                time: slot.time,
              },
            );
          } catch (error) {
            this.logger.warn(
              `kassa ${cashboxUserId} kechikish xabari (ochish, ${slot.key}): ${errorText(error)}`,
            );
          }
        }
      }
    }
    for (const slot of dueLateSlots(now, autoClose.times, late.grace_min)) {
      for (const shift of await this.openShifts(autoClose, slot.at)) {
        try {
          await alerter.send(
            lateCloseClaimKey(String(shift.id), slot.key),
            String(shift.id),
            {
              kind: 'close',
              cashbox_user_id: String(
                shift.cashbox_user_id ?? MAIN_CASHBOX_USER_ID,
              ),
              shift_id: String(shift.id),
              slot: slot.key,
              time: slot.time,
            },
          );
        } catch (error) {
          this.logger.warn(
            `smena #${shift.id} kechikish xabari (yopish, ${slot.key}): ${errorText(error)}`,
          );
        }
      }
    }
  }

  /**
   * Kechikish xabari yuboruvchisi: faol superadminlar tickda BIR marta
   * o'qiladi (identity javob bermasa — xato, kalit olinmaydi, keyingi tick
   * catch-up oynasida qayta uradi). Kalit + outbox BITTA tranzaksiyada.
   */
  private lateAlerter(
    settings: LateAlertSettings,
    sent: string[],
  ): LateAlerter {
    let recipients: Promise<string[]> | null = null;
    return {
      send: async (claimKey, shiftId, input) => {
        recipients ??= this.reports.activeSuperadminIds();
        const ids = await recipients;
        if (!ids.length) return false;
        const done = await this.dataSource.transaction(async (manager) => {
          const claim = await manager
            .createQueryBuilder()
            .insert()
            .into(ShiftScheduleClaim)
            .values({
              key: claimKey,
              shift_id: shiftId,
              kind: input.kind === 'open' ? 'late_open' : 'late_close',
              slot: input.slot,
            })
            .orIgnore()
            .returning(['key'])
            .execute();
          if (!Array.isArray(claim.raw) || !claim.raw.length) return false;
          return this.notifications.shiftLateAlert(
            {
              ...input,
              grace_min: settings.grace_min,
              recipient_ids: ids,
              channels: settings.channels,
            },
            manager,
          );
        });
        if (done) {
          sent.push(claimKey);
          this.logger.log(`kechikish xabari yuborildi: ${claimKey}`);
        }
        return done;
      },
    };
  }

  private async warn(
    now: Date,
    settings: AutoCloseSettings,
  ): Promise<string[]> {
    const warned: string[] = [];
    for (const slot of dueWarnSlots(
      now,
      settings.times,
      settings.warn_before_min,
    )) {
      for (const shift of await this.openShifts(settings, slot.at)) {
        try {
          if (await this.warnOne(shift, slot, now)) {
            warned.push(String(shift.id));
          }
        } catch (error) {
          this.logger.warn(
            `smena #${shift.id} ogohlantirishi: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return warned;
  }

  /**
   * Kalit + outbox BITTA tranzaksiyada — har slot uchun bir marta. Tizim
   * ochgan smenada (`opened_by = NULL`) ogohlantiriladigan xodim yo'q.
   */
  private async warnOne(
    shift: Shift,
    slot: ScheduleSlot,
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const claim = await manager
        .createQueryBuilder()
        .insert()
        .into(ShiftScheduleClaim)
        .values({
          key: warnClaimKey(String(shift.id), slot.key),
          shift_id: String(shift.id),
          kind: 'warn',
          slot: slot.key,
        })
        .orIgnore()
        .returning(['key'])
        .execute();
      if (!Array.isArray(claim.raw) || !claim.raw.length) return false;
      return this.notifications.shiftAutoCloseWarning(
        {
          shift_id: String(shift.id),
          recipient_id: shift.opened_by,
          slot: slot.key,
          time: slot.time,
          minutes_left: (slot.at.getTime() - now.getTime()) / 60_000,
        },
        manager,
      );
    });
  }
}

function errorText(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  return raw.slice(0, 200);
}
