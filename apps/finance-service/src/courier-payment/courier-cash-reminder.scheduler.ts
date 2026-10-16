import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { FinanceNotificationService } from '../notification/finance-notification.service';

/** Bir yugurishda ko'pi bilan shuncha kuryer (qolgani ertaga). */
const BATCH_LIMIT = 5000;
const TICK_MS = 10 * 60_000;
const TASHKENT_OFFSET_MS = 5 * 3_600_000;

export interface CashReminderRun {
  couriers: number;
  enqueued: number;
  failed: number;
}

/**
 * (2crjWf7v #2) Kuryer kassasidagi naqd `COURIER_CASH_REMINDER_THRESHOLD`
 * (so'm) dan OSHSA — kuryerga "💰 Kassangizda X so'm — filialga topshiring"
 * (`finance.cash_reminder`, in-app + Telegram DM). Chegara va soat ENV'dan
 * (2-savol: sozlanadigan); chegara berilmasa — o'chiq.
 *
 * KUNIGA BIR MARTA (spam yo'q): `client_request_id` =
 * UUID(`cash-reminder:<kuryer>:<Toshkent sanasi>`) — notification-service
 * dispatch dedup'i (rzGKtE9N) ayni kunning ikkinchi urinishini (qayta ishga
 * tushish, ko'p replika) yubormaydi. Kuryer moliyada faqat O'QUVCHI — bu
 * eslatma hech qanday pul yozuvi yaratmaydi.
 */
@Injectable()
export class CourierCashReminderScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CourierCashReminderScheduler.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastDay: string | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Cashbox)
    private readonly cashboxes: Repository<Cashbox>,
    @Optional() private readonly notifications?: FinanceNotificationService,
  ) {}

  /** Chegara (so'm); `null` — o'chiq. */
  threshold(): number | null {
    const raw = this.config.get<unknown>('COURIER_CASH_REMINDER_THRESHOLD');
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim()
          ? Number(raw.trim())
          : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private hour(): number {
    const raw = Number(this.config.get<unknown>('COURIER_CASH_REMINDER_HOUR'));
    return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 18;
  }

  /** finance-service'da ScheduleModule yo'q — oddiy interval (unref). */
  onModuleInit(): void {
    const threshold = this.threshold();
    if (!threshold || !this.notifications) return;
    this.logger.log(
      `Kuryer kassa eslatmasi yoqilgan: > ${threshold} so'm, soat ${this.hour()}:00 (Toshkent)`,
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: Date = new Date()): Promise<CashReminderRun | null> {
    const threshold = this.threshold();
    if (!threshold || this.running) return null;
    const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    const day = local.toISOString().slice(0, 10);
    if (local.getUTCHours() < this.hour() || this.lastDay === day) return null;
    this.running = true;
    try {
      const result = await this.run(day, threshold);
      this.lastDay = day;
      if (result.couriers) {
        this.logger.log(
          `Kassa eslatmasi ${day}: ${result.enqueued}/${result.couriers} navbatga, ${result.failed} xato`,
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Kassa eslatmasi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  async run(day: string, threshold: number): Promise<CashReminderRun> {
    const result: CashReminderRun = { couriers: 0, enqueued: 0, failed: 0 };
    if (!this.notifications) return result;
    const rows = await this.cashboxes.find({
      where: {
        cashbox_type: Cashbox_type.FOR_COURIER,
        isDeleted: false,
        balance: MoreThan(threshold),
      },
      select: ['id', 'user_id', 'balance'],
      order: { user_id: 'ASC' },
      take: BATCH_LIMIT,
    });
    result.couriers = rows.length;
    for (const row of rows) {
      try {
        const enqueued = await this.notifications.cashReminder({
          courier_id: String(row.user_id),
          // PG numeric satr bo'lishi mumkin — Number().
          balance: Number(row.balance),
          day,
        });
        if (enqueued) result.enqueued += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Kassa eslatmasi (kuryer ${String(row.user_id)}): ${error instanceof Error ? error.message : 'error'}`,
        );
      }
    }
    return result;
  }
}
