import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { DataSource } from 'typeorm';
import { captureException } from '@app/common';
import { SmsConfigService } from './sms-config.service';
import { SmsOutboxService } from './sms-outbox.service';
import { SmsProviderRegistry } from './sms-provider.registry';
import { maskPhone } from './sms-phone.util';
import { SmsProviderError } from './sms.port';

/**
 * Advisory lock NOMI integration-service lock'idan boshqa — ular urushmasin.
 * Ikki replika bir vaqtda tick qilsa faqat bittasi ishlaydi; qator darajasida
 * esa `FOR UPDATE SKIP LOCKED` qo'shimcha himoya.
 */
export const SMS_OUTBOX_LOCK_NAME = 'notification.sms-outbox.tick';
const JOB_NAME = 'notification.sms-outbox.tick';
const BALANCE_JOB_NAME = 'notification.sms-balance.check';
const SHUTDOWN_TIMEOUT_MS = 25_000;
/** Har xabardan keyin pauza — provayder rate-limitiga rioya. */
const SEND_PAUSE_MS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** SMS navbati drayveri (3fRbyadQ #4) — sync-queue.scheduler naqshi. */
@Injectable()
export class SmsOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsOutboxScheduler.name);
  private running = false;
  private shuttingDown = false;
  private job?: CronJob;
  private balanceJob?: CronJob;
  /** Balans monitori — SmsBalanceMonitor ro'yxatdan o'tkazadi. */
  balanceCheck?: () => Promise<unknown>;

  constructor(
    private readonly config: SmsConfigService,
    private readonly outbox: SmsOutboxService,
    private readonly registry: SmsProviderRegistry,
    private readonly scheduler: SchedulerRegistry,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    if (!this.config.cronEnabled) {
      this.logger.warn(
        "SMS_CRON_ENABLED=false — SMS navbati avtomatik yuborilmaydi (qatorlar 'pending' da qoladi).",
      );
      return;
    }
    this.job = new CronJob(this.config.cronExpression, () => void this.tick());
    this.scheduler.addCronJob(JOB_NAME, this.job as never);
    this.job.start();
    this.balanceJob = new CronJob(this.config.balanceCronExpression, () => {
      void this.balanceCheck?.().catch((error: unknown) =>
        this.logger.error(
          `SMS balans tekshiruvi yiqildi: ${(error as Error).message}`,
        ),
      );
    });
    this.scheduler.addCronJob(BALANCE_JOB_NAME, this.balanceJob as never);
    this.balanceJob.start();
    this.logger.log(
      `SMS navbati ishga tushdi: cron='${this.config.cronExpression}', batch=${this.config.batchSize}, SMS_ENABLED=${this.config.enabled}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const job of [this.job, this.balanceJob]) {
      try {
        if (job) void job.stop();
      } catch {
        // allaqachon to'xtagan
      }
    }
    // In-flight tick tugashini kutamiz — qator 'processing' da qotib qolmasin.
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) await sleep(100);
    if (this.running) {
      this.logger.warn(
        "SMS tick 25 s ichida tugamadi — qolgan qatorlar keyingi startda qayta navbatga qo'yiladi.",
      );
    }
  }

  /** Bitta tick. Xatolar yutiladi (log + Sentry) — scheduler yiqilmaydi. */
  async tick(): Promise<{
    processed: number;
    sent: number;
    failed: number;
  } | null> {
    if (this.running || this.shuttingDown) return null;
    this.running = true;
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [row] = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [SMS_OUTBOX_LOCK_NAME],
      )) as Array<{ locked: boolean }>;
      locked = Boolean(row?.locked);
      if (!locked) return null;
      return await this.processBatch();
    } catch (error) {
      const e = error as Error;
      this.logger.error(`SMS tick yiqildi: ${e.message}`, e.stack);
      captureException(e, { source: 'SmsOutboxScheduler.tick' });
      return null;
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock(hashtext($1))', [
            SMS_OUTBOX_LOCK_NAME,
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
      this.running = false;
    }
  }

  private async processBatch() {
    // Kill-switch: navbat SAQLANADI (qatorlar urinish sarflab 'failed' bo'lmaydi),
    // faqat yuborish to'xtaydi. Yoqilganda davom etadi.
    if (!this.config.enabled) return { processed: 0, sent: 0, failed: 0 };
    const rows = await this.outbox.claimDue(this.config.batchSize);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      if (this.shuttingDown) {
        // Egallangan, lekin yuborilmagan — darhol qayta navbatga (qotmasin).
        await this.outbox.markFailed(row, 'shutdown before send', true);
        continue;
      }
      try {
        const adapter = await this.registry.resolve(row.sender_profile);
        if (!adapter) {
          throw new SmsProviderError(
            `SMS provayder akkaunti sozlanmagan (${this.config.provider}/${row.sender_profile})`,
            true,
          );
        }
        const result = await adapter.send({
          to: row.to_phone,
          text: row.text,
          messageClass: row.message_class,
          clientMessageId: row.client_message_id,
          callbackUrl: this.registry.callbackUrl(row.client_message_id),
        });
        await this.outbox.markAccepted(
          row,
          result.providerMessageId,
          result.raw ?? null,
        );
        sent += 1;
      } catch (error) {
        const providerError = error instanceof SmsProviderError ? error : null;
        const message = error instanceof Error ? error.message : 'unknown';
        const terminal = await this.outbox.markFailed(
          row,
          message,
          providerError ? providerError.retryable : true,
          providerError?.response ?? null,
        );
        if (terminal) failed += 1;
        this.logger.warn(
          `SMS #${row.id} (${maskPhone(row.to_phone)}) yuborilmadi${terminal ? ' — TERMINAL' : ', qayta urinadi'}: ${message}`,
        );
      }
      await sleep(SEND_PAUSE_MS);
    }
    return { processed: rows.length, sent, failed };
  }
}
