import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  deterministicUuid,
  endOfTashkentDay,
  rmqSend,
} from '@app/common';
import { NotificationInboxService } from '../../notification-inbox.service';
import { BotGatewayClient } from '../bot-gateway.client';
import { buildCourierDailyReport } from './courier.handler';

const JOB_NAME = 'telegram-courier-daily-report';

/** (rzGKtE9N) umumiy yordamchiga ko'chdi — eski import yo'li saqlanadi. */
export { deterministicUuid };

export interface DailyReportRun {
  couriers: number;
  dispatched: number;
  failed: number;
}

/**
 * (4BirMSVp #2, #5) Kuryerlarga avtomatik kunlik hisobot. Vaqt —
 * `COURIER_DAILY_REPORT_CRON` (Asia/Tashkent, sekund maydoni bilan, masalan
 * `0 0 21 * * *`); bo'sh — o'chiq (vaqtni ega belgilaydi, kodga qotirilmagan).
 *
 * - Faqat Telegram'ga ULANGAN faol kuryerlar (bog'lanmaganga urinilmaydi).
 * - Har kuryer ketma-ket: o'z JWT'si bilan mavjud manbalar (analytics,
 *   my-cashbox) → `notification.dispatch` (in-app + Telegram). Telegram
 *   yuborish outbox orqali — global ~25 msg/s token-bucket, 429 da
 *   `retry_after`, bloklagan chat `blocked_at` (keyingi rejada o'tkaziladi).
 * - `client_request_id` = UUID(`courier-daily:<user>:<sana>`) — qayta ishga
 *   tushsa ham kuniga bitta xabar.
 */
@Injectable()
export class CourierReportScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CourierReportScheduler.name);
  private job?: CronJob;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly gateway: BotGatewayClient,
    private readonly moduleRef: ModuleRef,
    @Inject('IDENTITY') private readonly identity: ClientProxy,
  ) {}

  onModuleInit(): void {
    const cron = String(
      this.config.get<string>('COURIER_DAILY_REPORT_CRON') ?? '',
    ).trim();
    if (!cron) return;
    try {
      this.job = CronJob.from({
        cronTime: cron,
        onTick: () => void this.run(),
        start: false,
        timeZone: 'Asia/Tashkent',
      });
    } catch (error) {
      this.logger.error(
        `COURIER_DAILY_REPORT_CRON noto'g'ri ('${cron}') — avtomatik hisobot o'chiq: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.scheduler.addCronJob(JOB_NAME, this.job as never);
    this.job.start();
    this.logger.log(`Kuryer kunlik hisoboti: cron='${cron}' (Toshkent)`);
  }

  onModuleDestroy(): void {
    try {
      if (this.job) void this.job.stop();
    } catch {
      // allaqachon to'xtagan
    }
  }

  async run(now: Date = new Date()): Promise<DailyReportRun> {
    const result: DailyReportRun = { couriers: 0, dispatched: 0, failed: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const day = endOfTashkentDay(now).toISOString().slice(0, 10);
      const response = await rmqSend<{
        data?: Array<{ user_id: string; telegram_id: string }>;
      }>(
        this.identity,
        { cmd: 'identity.telegram.linked_users' },
        { role: 'courier' },
        { timeoutMs: 10_000 },
      );
      const couriers = response?.data ?? [];
      result.couriers = couriers.length;
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      for (const courier of couriers) {
        try {
          const body = await buildCourierDailyReport(
            this.gateway,
            courier.telegram_id,
          );
          await inbox.dispatch({
            type: 'courier.daily_report',
            category: NotificationCategory.SYSTEM,
            priority: NotificationPriority.LOW,
            title: '📊 Bugungi hisobot',
            body,
            recipient_id: courier.user_id,
            channels: [
              NotificationChannel.IN_APP,
              NotificationChannel.TELEGRAM,
            ],
            client_request_id: deterministicUuid(
              `courier-daily:${courier.user_id}:${day}`,
            ),
          } as never);
          result.dispatched += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.warn(
            `kunlik hisobot (kuryer ${courier.user_id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.logger.log(
        `Kunlik hisobot: ${result.dispatched}/${result.couriers} yuborildi, ${result.failed} xato`,
      );
    } catch (error) {
      this.logger.error(
        `Kunlik hisobot ishga tushmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    return result;
  }
}
