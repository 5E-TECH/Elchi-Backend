import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CourierHoldService,
  type CourierHoldWarnResult,
} from './courier-hold.service';
import {
  courierHoldInQuiet,
  readCourierHoldWarnConfig,
  type CourierHoldWarnConfig,
} from './courier-hold';

/** Tik oralig'i — 10 daqiqa (12 soatlik oyna uchun yetarli aniqlik). */
export const COURIER_HOLD_WARN_TICK_MS = 10 * 60_000;
/** Bir tikda partiya to'lsa — ko'pi bilan shuncha qayta urinish. */
export const COURIER_HOLD_WARN_MAX_ROUNDS = 5;

/**
 * onXzDc5n — har 10 daqiqada: kuryerda 36 soatga yetgan buyurtmalar bo'yicha
 * kuryer va marketga BIR MARTALIK ogohlantirish (`CourierHoldService.warnDue`).
 * Tungi taqiqda (`COURIER_HOLD_WARN_QUIET_HOURS`, sukut 22:00-08:00 Toshkent)
 * hech narsa yuborilmaydi — kechasi kesib o'tganlar ertalabki birinchi tikda
 * bitta xabarda.
 *
 * `COURIER_HOLD_WARN_ENABLED` — sukut YOQIQ; `false` — o'chiq.
 *
 * order-service'da ScheduleModule yo'q — oddiy interval (unref). Takror
 * himoyasi — DB belgisi va advisory qulf: qayta ishga tushish yoki ikkinchi
 * replika ikkinchi xabar yubormaydi.
 */
@Injectable()
export class CourierHoldWarningScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CourierHoldWarningScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly service: CourierHoldService,
    private readonly config: ConfigService,
  ) {}

  settings(): CourierHoldWarnConfig {
    return readCourierHoldWarnConfig((key) => this.config.get<unknown>(key));
  }

  onModuleInit(): void {
    const settings = this.settings();
    if (!settings.enabled) {
      this.logger.log(
        "Kuryer 48 soat ogohlantirishi O'CHIQ (COURIER_HOLD_WARN_ENABLED=false)",
      );
      return;
    }
    this.logger.log(
      'Kuryer 48 soat ogohlantirishi yoqilgan: 36 soatda kuryer + marketga, har 10 daqiqada',
    );
    this.timer = setInterval(() => void this.tick(), COURIER_HOLD_WARN_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date = new Date()): Promise<CourierHoldWarnResult[] | null> {
    const settings = this.settings();
    if (!settings.enabled || this.running) return null;
    if (courierHoldInQuiet(now, settings)) return null;
    this.running = true;
    const runs: CourierHoldWarnResult[] = [];
    try {
      for (let round = 0; round < COURIER_HOLD_WARN_MAX_ROUNDS; round += 1) {
        const run = await this.service.warnDue(now);
        runs.push(run);
        if (!run.locked || !run.hit_limit) break;
      }
      return runs;
    } catch (error) {
      this.logger.warn(
        `Kuryer 48 soat ogohlantirishi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return runs.length ? runs : null;
    } finally {
      this.running = false;
    }
  }
}
