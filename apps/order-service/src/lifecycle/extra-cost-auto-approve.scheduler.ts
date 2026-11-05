import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolveExtraCostAutoApproveMinutes,
  resolveExtraCostAutoApproveReminderMinutes,
} from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * (1tnpaIqd, EGA QARORI 2026-09-20; AFZaUUi5, 2026-11-05) Market qo'shimcha
 * xarajat so'roviga `EXTRA_COST_AUTO_APPROVE_MINUTES` ichida javob bermasa —
 * so'rov AVTOMATIK tasdiqlanadi (kuryer kutib qolmaydi). Env bo'sh yoki
 * yozilmagan — 1440 daqiqa (24 soat), env bilan boshqa qiymat berish mumkin.
 * `EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES` (sukut 10) qolganda marketga
 * oxirgi eslatma.
 *
 * Har daqiqa; ko'p replikada xavfsiz — eslatma ham, tasdiq ham shartli
 * UPDATE bilan band qilinadi (bitta so'rov ikki marta tasdiqlanmaydi).
 */
@Injectable()
export class ExtraCostAutoApproveScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExtraCostAutoApproveScheduler.name);
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly lifecycle: OrderLifecycleService,
    private readonly config: ConfigService,
  ) {}

  private minutes(): number {
    return resolveExtraCostAutoApproveMinutes(
      this.config.get<unknown>('EXTRA_COST_AUTO_APPROVE_MINUTES'),
    );
  }

  private reminderMinutes(): number {
    return resolveExtraCostAutoApproveReminderMinutes(
      this.config.get<unknown>('EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES'),
    );
  }

  /** order-service'da ScheduleModule yo'q — oddiy interval (unref). */
  onModuleInit(): void {
    const minutes = this.minutes();
    const reminderMinutes = this.reminderMinutes();
    this.logger.log(
      `Extra-cost avtomatik tasdiq yoqilgan: ${minutes} daqiqa, eslatma ${reminderMinutes} daqiqa oldin`,
    );
    if (reminderMinutes >= minutes) {
      this.logger.warn(
        `EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES (${reminderMinutes}) muddatdan (${minutes}) kichik emas — eslatma yuborilmaydi`,
      );
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const minutes = this.minutes();
      const reminderMinutes = this.reminderMinutes();
      const stats = await this.lifecycle.runExtraCostAutoApproval({
        minutes,
        reminderMinutes,
      });
      if (stats.reminded || stats.approved || stats.failed || stats.deferred) {
        this.logger.log(
          `Extra-cost avtomatik: eslatma ${stats.reminded}, tasdiq ${stats.approved}, yopildi/xato ${stats.failed}, kechiktirildi ${stats.deferred}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Extra-cost avtomatik tasdiq: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
