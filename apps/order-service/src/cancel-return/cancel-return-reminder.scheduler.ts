import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CancelReturnReminderService,
  type CancelReturnStepResult,
} from './cancel-return-reminder.service';
import {
  cancelReturnReminderSlot,
  readCancelReturnReminderConfig,
  type CancelReturnReminderConfig,
} from './cancel-return-reminder';

/** Tik oralig'i — 10 daqiqa (kunlik yugurish shu tiklardan birida). */
export const CANCEL_RETURN_REMINDER_TICK_MS = 10 * 60_000;

export interface CancelReturnReminderRun {
  day: string;
  remind: CancelReturnStepResult;
  escalate: CancelReturnStepResult;
}

/**
 * vNKGbg5q (BG7) — kuniga BIR marta (Toshkent `CANCEL_RETURN_REMINDER_HOUR`,
 * sukut 10:00 dan keyin, tungi taqiq `NOTIF_PROMO_QUIET_HOURS` dan tashqarida):
 *   1) D+3 eslatma (market, `CANCEL_RETURN_REMIND_AFTER_DAYS`, sukut 3);
 *   2) D+7 eskalatsiya (admin, `CANCEL_RETURN_ESCALATE_AFTER_DAYS`, sukut 7).
 *
 * `CANCEL_RETURN_REMINDER_ENABLED` — sukut YOQIQ (ega qarori 2026-10-19:
 * «eslatma 3 kun / eskalatsiya 7 kun — ha»); `false` — o'chiq.
 *
 * order-service'da ScheduleModule yo'q — oddiy interval (unref). Kunlik
 * «bajarildi» belgisi faqat xotirada (tejash uchun); haqiqiy takror himoyasi —
 * DB belgilari va advisory qulf (`CancelReturnReminderService`): qayta ishga
 * tushish yoki ikkinchi replika ham ikkinchi xabar yubormaydi.
 */
@Injectable()
export class CancelReturnReminderScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CancelReturnReminderScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private doneDay: string | null = null;

  constructor(
    private readonly reminders: CancelReturnReminderService,
    private readonly config: ConfigService,
  ) {}

  settings(): CancelReturnReminderConfig {
    return readCancelReturnReminderConfig((key) =>
      this.config.get<unknown>(key),
    );
  }

  onModuleInit(): void {
    const settings = this.settings();
    if (!settings.enabled) {
      this.logger.log(
        "Bekor qaytarish eslatmasi O'CHIQ (CANCEL_RETURN_REMINDER_ENABLED=false)",
      );
      return;
    }
    this.logger.log(
      `Bekor qaytarish eslatmasi yoqilgan: ${settings.remindAfterDays} kun → market, ${settings.escalateAfterDays} kun → admin; har kuni ${settings.runHour}:00 dan (Toshkent)`,
    );
    this.timer = setInterval(
      () => void this.tick(),
      CANCEL_RETURN_REMINDER_TICK_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date = new Date()): Promise<CancelReturnReminderRun | null> {
    const settings = this.settings();
    if (!settings.enabled || this.running) return null;
    const slot = cancelReturnReminderSlot(now, settings);
    if (!slot || this.doneDay === slot.day) return null;
    this.running = true;
    try {
      const remind = await this.reminders.remindMarkets(slot.remindCutoff, now);
      const escalate = await this.reminders.escalateStale(
        slot.escalateCutoff,
        now,
      );
      // Qulf boshqa replikada bo'lsa yoki partiya to'lgan bo'lsa — keyingi
      // tikda yana (belgilar takrorni baribir to'xtatadi).
      if (
        remind.locked &&
        escalate.locked &&
        !remind.hit_limit &&
        !escalate.hit_limit
      ) {
        this.doneDay = slot.day;
      }
      return { day: slot.day, remind, escalate };
    } catch (error) {
      this.logger.warn(
        `Bekor qaytarish eslatmasi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }
}
