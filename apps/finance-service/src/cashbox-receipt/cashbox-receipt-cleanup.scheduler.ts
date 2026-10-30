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
import { CashboxReceiptService } from './cashbox-receipt.service';

const JOB_NAME = 'finance-cashbox-receipt-cleanup';
/** Har soat boshida (sekund maydoni bilan), Asia/Tashkent. */
export const RECEIPT_CLEANUP_CRON = '0 5 * * * *';
/** Replikalararo qulf — faqat ortiqcha ishni kesadi (to'g'rilik — FOR UPDATE). */
export const RECEIPT_CLEANUP_LOCK_KEY = 716_000_000_188;

/**
 * T3 (QlLf33Ma) — bog'lanmagan chek QORALAMALARINI tozalash: har soat 24
 * soatdan eski `draft` → `file.delete` + soft-delete. `linked` cheklar
 * tegilmaydi. `FINANCE_RECEIPT_CLEANUP=off` — cron ishga tushmaydi.
 */
@Injectable()
export class CashboxReceiptCleanupScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CashboxReceiptCleanupScheduler.name);
  private job?: CronJob;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly receipts: CashboxReceiptService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly registry?: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const flag = String(
      this.config?.get<string>('FINANCE_RECEIPT_CLEANUP') ?? '',
    )
      .trim()
      .toLowerCase();
    if (flag === 'off' || flag === 'false' || flag === '0') {
      this.logger.warn(
        'FINANCE_RECEIPT_CLEANUP=off — chek qoralamalari tozalanmaydi',
      );
      return;
    }
    this.job = CronJob.from({
      cronTime: RECEIPT_CLEANUP_CRON,
      onTick: () => void this.tick(),
      start: false,
      timeZone: 'Asia/Tashkent',
    });
    try {
      this.registry?.addCronJob(JOB_NAME, this.job);
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

  async tick(
    now: Date = new Date(),
  ): Promise<{ locked: boolean; deleted: number; failed: number }> {
    const result = { locked: false, deleted: 0, failed: 0 };
    if (this.running) return result;
    this.running = true;
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows: Array<{ ok?: boolean }> = await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS ok',
        [RECEIPT_CLEANUP_LOCK_KEY],
      );
      locked = rows?.[0]?.ok === true;
      if (!locked) return result;
      result.locked = true;
      const run = await this.receipts.cleanupDrafts(now);
      result.deleted = run.deleted;
      result.failed = run.failed;
      if (run.deleted || run.failed) {
        this.logger.log(
          `chek qoralamalari: o'chirildi=${run.deleted}, xato=${run.failed}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `chek qoralamalarini tozalash xatosi: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock($1::bigint)', [
            RECEIPT_CLEANUP_LOCK_KEY,
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
      this.running = false;
    }
    return result;
  }
}
