import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { captureException } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * Ochiq posilkalar holatini davriy SOLISHTIRUVCHI (DOZ6dtJn).
 *
 * MUAMMO. Posilka holati faqat tashuvchi webhooki orqali yangilanardi.
 * Webhook yo'qolsa (tarmoq, tashuvchi xatosi, sekret almashuvi) buyurtma
 * abadiy "kutilmoqda" da qolardi va buni hech kim sezmasdi.
 *
 * `SyncQueueScheduler` naqshi AYNAN takrorlanadi:
 *   1. In-process `running` bayrog'i — tick interval'dan oshsa keyingisi
 *      o'tkazib yuboriladi.
 *   2. `pg_try_advisory_lock` (alohida kalit, `reconcileDueIntegrations`
 *      ichida) — ikki replika bir posilkani ikki marta qayta ishlamaydi.
 *   3. Graceful shutdown — davom etayotgan tick tugashi kutiladi (chegara
 *      bilan).
 *
 * Qaysi ulanish solishtiriladi — master (`is_active`) VA `reconcile_enabled`
 * yoqiq, `status_sync_config.status_query` sozlangan.
 */
@Injectable()
export class ReconcileScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileScheduler.name);
  private static readonly JOB_NAME = 'integration.reconcile.tick';
  private static readonly SHUTDOWN_TIMEOUT_MS = 25_000;

  private running = false;
  private shuttingDown = false;
  private job?: CronJob;

  constructor(
    @Inject(IntegrationServiceService)
    private readonly integrationService: IntegrationServiceService,
    @Inject(SchedulerRegistry)
    private readonly scheduler: SchedulerRegistry,
    @Inject(ConfigService)
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>(
      'INTEGRATION_RECONCILE_CRON_ENABLED',
      true,
    );
    if (!enabled) {
      this.logger.warn(
        'INTEGRATION_RECONCILE_CRON_ENABLED=false — davriy solishtiruvchi o`chiq. Faqat "Hoziroq tenglashtirish" ishlaydi.',
      );
      return;
    }

    const expression = this.config.get<string>(
      'INTEGRATION_RECONCILE_CRON_EXPR',
      '0 */15 * * * *',
    );
    this.job = new CronJob(expression, () => {
      void this.tick();
    });
    this.scheduler.addCronJob(ReconcileScheduler.JOB_NAME, this.job as never);
    this.job.start();
    this.logger.log(
      `reconcile scheduler started: cron='${expression}', batch=${this.batchSize()}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.job) {
      try {
        void this.job.stop();
      } catch {
        // Already stopped — ignore.
      }
    }
    const deadline = Date.now() + ReconcileScheduler.SHUTDOWN_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.running) {
      this.logger.warn(
        `reconcile tick still running after ${ReconcileScheduler.SHUTDOWN_TIMEOUT_MS}ms — forcing shutdown`,
      );
    }
  }

  /** Bitta tick. Xatolar yutiladi (log + Sentry) — cron o'lmasin. */
  async tick(): Promise<void> {
    if (this.running || this.shuttingDown) {
      return;
    }
    this.running = true;
    try {
      const result = (await this.integrationService.reconcileDueIntegrations(
        this.batchSize(),
      )) as {
        data?: {
          skipped?: string;
          results?: Array<{ applied?: number; failed?: number }>;
        };
      };
      const results = result?.data?.results ?? [];
      const applied = results.reduce((sum, r) => sum + (r.applied ?? 0), 0);
      const failed = results.reduce((sum, r) => sum + (r.failed ?? 0), 0);
      if (applied > 0 || failed > 0) {
        this.logger.log(
          `reconcile tick: integrations=${results.length} applied=${applied} failed=${failed}`,
        );
      }
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `reconcile tick crashed: ${error.message}`,
        error.stack,
      );
      captureException(error, { source: 'ReconcileScheduler.tick' });
    } finally {
      this.running = false;
    }
  }

  /** Exposed for testing — checks the in-flight guard. */
  isRunning(): boolean {
    return this.running;
  }

  private batchSize(): number {
    const raw = this.config.get<number>(
      'INTEGRATION_RECONCILE_BATCH_SIZE',
      200,
    );
    return Math.max(1, Math.min(1000, Number(raw) || 200));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
