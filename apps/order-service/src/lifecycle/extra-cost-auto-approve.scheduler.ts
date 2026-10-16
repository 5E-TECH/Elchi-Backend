import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * (1tnpaIqd, EGA QARORI 2026-09-20) Market qo'shimcha xarajat so'roviga
 * `EXTRA_COST_AUTO_APPROVE_MINUTES` ichida javob bermasa — so'rov AVTOMATIK
 * tasdiqlanadi (kuryer kutib qolmaydi). Qiymat ENV'dan (kodga qotirilmagan);
 * berilmasa — o'chiq. `EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES` (sukut 10)
 * qolganda marketga oxirgi eslatma.
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

  private readInt(key: string, fallback: number | null): number | null {
    const raw = this.config.get<unknown>(key);
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim()
          ? Number(raw.trim())
          : NaN;
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  /** order-service'da ScheduleModule yo'q — oddiy interval (unref). */
  onModuleInit(): void {
    const minutes = this.readInt('EXTRA_COST_AUTO_APPROVE_MINUTES', null);
    if (!minutes) return;
    this.logger.log(`Extra-cost avtomatik tasdiq yoqilgan: ${minutes} daqiqa`);
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const minutes = this.readInt('EXTRA_COST_AUTO_APPROVE_MINUTES', null);
    if (!minutes || this.running) return;
    this.running = true;
    try {
      const reminderMinutes =
        this.readInt('EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES', 10) ?? 10;
      const stats = await this.lifecycle.runExtraCostAutoApproval({
        minutes,
        reminderMinutes,
      });
      if (stats.reminded || stats.approved || stats.failed) {
        this.logger.log(
          `Extra-cost avtomatik: eslatma ${stats.reminded}, tasdiq ${stats.approved}, xato ${stats.failed}`,
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
