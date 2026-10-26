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
import { FinanceServiceService } from '../finance-service.service';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { ShiftScheduleClaim } from '../entities/shift-schedule-claim.entity';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { ShiftAccountCheckService } from '../shift-account-check/shift-account-check.service';
import { ShiftReportService } from '../shift-report/shift-report.service';
import {
  dueCloseSlots,
  dueWarnSlots,
  warnClaimKey,
  type AutoCloseSettings,
  type ScheduleSlot,
} from './shift-schedule.rules';

const JOB_NAME = 'finance-shift-auto-close';
/** Har daqiqa (sekund maydoni bilan), Asia/Tashkent. */
export const SHIFT_SCHEDULER_CRON = '0 * * * * *';
/**
 * Replikalararo tick qulfi (`pg_try_advisory_lock`). Qulf bandi — shu tick
 * o'tkaziladi. Bu faqat ortiqcha ishni kesadi; TO'G'RILIK kafolati —
 * smena qatori FOR UPDATE + `shift_schedule_claims` PRIMARY KEY.
 */
export const SHIFT_SCHEDULER_LOCK_KEY = 716_000_000_167;

export interface ShiftTickResult {
  locked: boolean;
  enabled: boolean;
  closed: string[];
  warned: string[];
  reports: number;
}

/**
 * y8Tqm9Ap — smenani jadval bo'yicha AVTOMATIK yopish (+ ogohlantirish) va
 * gWI4gYkw — qolib ketgan smena hisobotlarini yuborish.
 *
 * Har daqiqa: superadmin sozlamasi (`shift.auto_close.*`) o'qiladi →
 *  - o'chiq — hech narsa yopilmaydi / ogohlantirilmaydi;
 *  - `warn_before_min` oynasida — smenani ochgan xodimga BIR marta
 *    ogohlantirish (`warn:<shift>:<slot>` kaliti + outbox, bitta tranzaksiya);
 *  - slot vaqti kelgan (catch-up 10 daqiqa) — `opened_at < slot` bo'lgan
 *    ochiq smenalar `autoCloseShift` bilan yopiladi (qamrov: `main` — faqat
 *    asosiy kassa, `main+branches` — filiallar ham).
 * Keyingi smena avtomatik OCHILMAYDI.
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
      const { auto_close } = await this.checks.loadAutomationSettings();
      result.enabled = auto_close.enabled;
      if (auto_close.enabled && auto_close.times.length) {
        result.warned = await this.warn(now, auto_close);
        result.closed = await this.close(now, auto_close);
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
    settings: AutoCloseSettings,
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

  private async close(
    now: Date,
    settings: AutoCloseSettings,
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
          this.logger.error(
            `smena #${shift.id} avtomatik yopilmadi (slot ${slot.key}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return closed;
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

  /** Kalit + outbox BITTA tranzaksiyada — har slot uchun bir marta. */
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
