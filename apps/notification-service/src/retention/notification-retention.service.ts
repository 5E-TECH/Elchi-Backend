import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { DataSource, Repository } from 'typeorm';
import { captureException } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { InboxPolicyService, RetentionSettings } from './inbox-policy.service';

/** sms-outbox / integration lock'laridan BOSHQA nom — urushmasin. */
export const NOTIF_RETENTION_LOCK_NAME = 'notification.inbox.retention';
const JOB_NAME = 'notification.inbox.retention';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 25_000;
/** Partiyalar orasida qisqa pauza — replikatsiya/WAL nafas olsin. */
const BATCH_PAUSE_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetentionCounts {
  read: number;
  unread: number;
}

export interface RetentionRunResult {
  dry_run: boolean;
  read_before: string;
  unread_before: string;
  /** O'chirishdan OLDIN `SELECT count(*)` (DIQQAT b) — logga ham. */
  eligible: RetentionCounts;
  deleted: RetentionCounts;
  batches: number;
  stopped: 'done' | 'max_batches' | 'shutdown';
}

/**
 * INBOX RETENTION (A1HzKEby #3). Kunlik cron `notifications` jadvalidan
 * eski qatorlarni PARTIYALAB (`DELETE ... WHERE id IN (SELECT ... LIMIT N)`)
 * o'chiradi — bitta katta DELETE YO'Q (uzoq qulf va replikatsiya lag'i).
 *
 * Qoidalar:
 * - o'qilgan qator — `NOTIF_RETENTION_READ_DAYS` dan eski bo'lsa;
 * - o'qilmagan qator — `NOTIF_RETENTION_UNREAD_DAYS` dan eski (sezilarli
 *   UZUNROQ; teng yoki qisqa sozlansa retention umuman ishlamaydi);
 * - `priority = 'critical'` — HECH QACHON o'chirilmaydi;
 * - yosh — `createdAt` bo'yicha (group_key qatorida — OXIRGI hodisa vaqti).
 *
 * ⚠️ Sukut O'CHIQ (`NOTIF_RETENTION_ENABLED=false`): deploy bilan prod'da
 * avtomatik ommaviy o'chirish boshlanib ketmaydi. Birinchi yoqishda
 * `NOTIF_RETENTION_DRY_RUN=true` — faqat sanaydi va logga yozadi.
 * Indeks: `IDX_NOTIF_RETENTION (is_read, createdAt) WHERE priority <> 'critical'`
 * (migratsiya 1716000000108) — kunlik so'rov jadvalni to'liq skanerlamaydi.
 * Bir nechta replika — `pg_try_advisory_lock`: bir vaqtda faqat bittasi.
 */
@Injectable()
export class NotificationRetentionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRetentionService.name);
  private running = false;
  private shuttingDown = false;
  private job?: CronJob;

  constructor(
    private readonly policy: InboxPolicyService,
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
    private readonly scheduler: SchedulerRegistry,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    const settings = this.policy.retention;
    if (!settings.enabled) {
      this.logger.log(
        "NOTIF_RETENTION_ENABLED=false — inbox retention o'chiq (hech narsa o'chirilmaydi).",
      );
      return;
    }
    if (settings.invalid) {
      this.logger.error(
        `Inbox retention ISHGA TUSHMADI (hech narsa o'chirilmaydi): ${settings.invalid}`,
      );
      return;
    }
    this.job = CronJob.from({
      cronTime: settings.cron,
      onTick: () => void this.tick(),
      start: false,
      timeZone: 'Asia/Tashkent',
    });
    this.scheduler.addCronJob(JOB_NAME, this.job as never);
    this.job.start();
    this.logger.log(
      `Inbox retention: cron='${settings.cron}' (Toshkent), o'qilgan ${settings.readDays} kun, ` +
        `o'qilmagan ${settings.unreadDays} kun, partiya ${settings.batchSize}, ` +
        `max ${settings.maxBatches} partiya/ishga tushish, dry_run=${settings.dryRun}; critical — o'chirilmaydi.`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    try {
      if (this.job) void this.job.stop();
    } catch {
      // allaqachon to'xtagan
    }
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) await sleep(100);
  }

  /** Cron tick: advisory lock + prune. Xato yutiladi (log + Sentry). */
  async tick(now: Date = new Date()): Promise<RetentionRunResult | null> {
    if (this.running || this.shuttingDown) return null;
    this.running = true;
    const runner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [row] = (await runner.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [NOTIF_RETENTION_LOCK_NAME],
      )) as Array<{ locked: boolean }>;
      locked = Boolean(row?.locked);
      if (!locked) return null;
      return await this.prune(now);
    } catch (error) {
      const e = error as Error;
      this.logger.error(`Inbox retention yiqildi: ${e.message}`, e.stack);
      captureException(e, { source: 'NotificationRetentionService.tick' });
      return null;
    } finally {
      if (locked) {
        await runner
          .query('SELECT pg_advisory_unlock(hashtext($1))', [
            NOTIF_RETENTION_LOCK_NAME,
          ])
          .catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
      this.running = false;
    }
  }

  /** Muddat chegaralari: `now - N kun`. */
  cutoffs(
    now: Date,
    settings: RetentionSettings = this.policy.retention,
  ): { readBefore: Date; unreadBefore: Date } {
    return {
      readBefore: new Date(now.getTime() - settings.readDays * DAY_MS),
      unreadBefore: new Date(now.getTime() - settings.unreadDays * DAY_MS),
    };
  }

  /** DIQQAT (b): nechta qator ketadi — o'chirmasdan sanaydi. */
  async preview(
    now: Date = new Date(),
    settings: RetentionSettings = this.policy.retention,
  ): Promise<RetentionCounts> {
    const { readBefore, unreadBefore } = this.cutoffs(now, settings);
    const [read, unread] = await Promise.all([
      this.eligible(true, readBefore).getCount(),
      this.eligible(false, unreadBefore).getCount(),
    ]);
    return { read, unread };
  }

  /**
   * Bitta ishga tushish: avval sanaydi (log), so'ng — dry run bo'lmasa —
   * o'qilganlar, keyin o'qilmaganlar partiyama-partiya. Bitta ishga
   * tushishda `maxBatches` dan ko'p partiya yo'q (qolgani ertaga).
   */
  async prune(
    now: Date = new Date(),
    settings: RetentionSettings = this.policy.retention,
  ): Promise<RetentionRunResult> {
    if (settings.invalid) throw new Error(settings.invalid);
    const { readBefore, unreadBefore } = this.cutoffs(now, settings);
    const eligible = await this.preview(now, settings);
    const result: RetentionRunResult = {
      dry_run: settings.dryRun,
      read_before: readBefore.toISOString(),
      unread_before: unreadBefore.toISOString(),
      eligible,
      deleted: { read: 0, unread: 0 },
      batches: 0,
      stopped: 'done',
    };
    this.logger.log(
      `Inbox retention: o'chirishga loyiq — o'qilgan ${eligible.read} (< ${result.read_before}), ` +
        `o'qilmagan ${eligible.unread} (< ${result.unread_before})${settings.dryRun ? " — DRY RUN, o'chirilmaydi" : ''}`,
    );
    if (settings.dryRun) return result;

    const phases: Array<{ key: keyof RetentionCounts; before: Date }> = [
      { key: 'read', before: readBefore },
      { key: 'unread', before: unreadBefore },
    ];
    outer: for (const phase of phases) {
      while (true) {
        if (this.shuttingDown) {
          result.stopped = 'shutdown';
          break outer;
        }
        if (result.batches >= settings.maxBatches) {
          result.stopped = 'max_batches';
          break outer;
        }
        const affected = await this.deleteBatch(
          phase.key === 'read',
          phase.before,
          settings.batchSize,
        );
        result.batches += 1;
        result.deleted[phase.key] += affected;
        if (affected < settings.batchSize) break;
        await sleep(BATCH_PAUSE_MS);
      }
    }
    this.logger.log(
      `Inbox retention tugadi: o'chirildi o'qilgan ${result.deleted.read}, o'qilmagan ${result.deleted.unread}, ` +
        `${result.batches} partiya (${result.stopped}).`,
    );
    return result;
  }

  /**
   * Loyiq qatorlar so'rovi. `priority <> 'critical'` — LITERAL (parametr
   * emas): qisman indeks predikati bilan aynan mos, rejalashtiruvchi
   * `IDX_NOTIF_RETENTION` ni tanlay oladi.
   */
  private eligible(isRead: boolean, before: Date) {
    return this.repo
      .createQueryBuilder('n')
      .where('n.is_read = :isRead', { isRead })
      .andWhere(`n.priority <> 'critical'`)
      .andWhere('n.createdAt < :before', { before });
  }

  /** Bitta partiya: `DELETE ... WHERE id IN (SELECT id ... LIMIT N)`. */
  private async deleteBatch(
    isRead: boolean,
    before: Date,
    limit: number,
  ): Promise<number> {
    const ids = this.eligible(isRead, before).select('n.id').limit(limit);
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(Notification)
      .where(`id IN (${ids.getQuery()})`)
      .setParameters(ids.getParameters())
      .execute();
    return Number(result.affected ?? 0);
  }
}
