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
import { ActivityLogService, captureException } from '@app/common';
import { IntegrationServiceService } from './integration-service.service';

/**
 * Periodic driver for the external-integration sync queue.
 *
 * Background: `IntegrationServiceService.processPendingSyncQueue` does the
 * heavy lifting — it pulls pending rows whose `next_retry_at` has elapsed,
 * issues the outbound HTTP request, applies the retry backoff, and writes a
 * sync_history row. It is HA-safe already (each tick acquires a session-
 * scoped `pg_try_advisory_lock`, so two replicas running this cron at the
 * same moment will not double-process: the second tick is a no-op).
 *
 * What was missing: nothing actually called it on a schedule. Items
 * enqueued via `integration.sync.enqueue` only moved if a human happened
 * to fire `integration.sync.trigger`. This scheduler closes that loop.
 *
 * Defensive layering (belt-and-suspenders):
 *   1. In-process `running` flag — if a tick over-runs the cron interval
 *      (e.g. partner API hanging), the next tick observes the flag and
 *      skips. No work is lost; it picks up on the following tick.
 *   2. pg_try_advisory_lock inside processPendingSyncQueue — protects
 *      across replicas.
 *   3. Graceful shutdown — onModuleDestroy waits for an in-flight tick
 *      (bounded) so a container restart doesn't leave a queue row stuck
 *      in `processing` mid-write.
 *
 * The cron is registered dynamically (SchedulerRegistry + CronJob) instead
 * of via `@Cron(...)` so the expression can be overridden by env without
 * rebuilding the image, and so the master switch can no-op cleanly.
 */
@Injectable()
export class SyncQueueScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncQueueScheduler.name);
  private static readonly JOB_NAME = 'integration.sync-queue.tick';
  private static readonly SHUTDOWN_TIMEOUT_MS = 25_000;

  private running = false;
  private shuttingDown = false;
  // Hold our own reference to the cron job. SchedulerRegistry.getCronJob
  // is the canonical lookup, but keeping a direct handle means we can
  // stop the timer in onModuleDestroy even if the registry has been torn
  // down ahead of us (e.g. in tests with a mocked registry).
  private job?: CronJob;

  constructor(
    @Inject(IntegrationServiceService)
    private readonly integrationService: IntegrationServiceService,
    @Inject(SchedulerRegistry)
    private readonly scheduler: SchedulerRegistry,
    @Inject(ConfigService)
    private readonly config: ConfigService,
    @Inject(ActivityLogService)
    private readonly activityLog: ActivityLogService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>(
      'INTEGRATION_SYNC_CRON_ENABLED',
      true,
    );
    if (!enabled) {
      this.logger.warn(
        'INTEGRATION_SYNC_CRON_ENABLED=false — sync queue auto-processor disabled. Items will only move on manual integration.sync.trigger.',
      );
      return;
    }

    const expression = this.config.get<string>(
      'INTEGRATION_SYNC_CRON_EXPR',
      '*/30 * * * * *',
    );

    // CronJob signature: (cronTime, onTick, onComplete, startNow)
    this.job = new CronJob(expression, () => {
      void this.tick();
    });

    this.scheduler.addCronJob(SyncQueueScheduler.JOB_NAME, this.job as never);
    this.job.start();
    this.logger.log(
      `sync queue auto-processor started: cron='${expression}', batch=${this.batchSize()}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    // Prefer our own reference — works even when the registry was mocked
    // (tests) or has already been torn down by Nest's shutdown sequence.
    if (this.job) {
      try {
        // cron@4 stop() returns a promise; we don't need to await it here —
        // the in-flight wait below covers the actual tick draining.
        void this.job.stop();
      } catch {
        // Already stopped — ignore.
      }
    }

    // Wait for an in-flight tick to finish so we don't kill the process
    // mid-HTTP-call and leave a queue row stuck in `processing`. Bounded so
    // a wedged outbound request can't block container restart indefinitely.
    const deadline = Date.now() + SyncQueueScheduler.SHUTDOWN_TIMEOUT_MS;
    while (this.running && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.running) {
      this.logger.warn(
        `sync queue tick still running after ${SyncQueueScheduler.SHUTDOWN_TIMEOUT_MS}ms — forcing shutdown`,
      );
    }
  }

  /**
   * One cron tick. Idempotent — safe to skip if the previous tick is still
   * running. All errors are swallowed (logged + Sentry-captured) so a single
   * bad tick does not crash the scheduler.
   */
  async tick(): Promise<void> {
    if (this.running || this.shuttingDown) {
      return;
    }
    this.running = true;

    try {
      const batch = this.batchSize();
      const result = (await this.integrationService.processPendingSyncQueue(
        batch,
      )) as unknown as {
        data?: { processed?: number; completed?: number; failed?: number };
      };

      const processed = Number(result?.data?.processed ?? 0);
      const completed = Number(result?.data?.completed ?? 0);
      const failed = Number(result?.data?.failed ?? 0);

      // Only audit ticks that did real work — quiet ticks would flood the
      // audit log with thousands of "0 processed" entries per day.
      if (processed > 0) {
        await this.activityLog.log({
          entity_type: 'SyncQueue',
          entity_id: 'tick',
          action: 'external_sync',
          metadata: {
            processed,
            completed,
            failed,
            batch_limit: batch,
          },
        });
      }

      if (failed > 0) {
        this.logger.warn(
          `sync tick: processed=${processed} completed=${completed} failed=${failed}`,
        );
      } else if (processed > 0) {
        this.logger.debug(
          `sync tick: processed=${processed} completed=${completed}`,
        );
      }
    } catch (err) {
      // Defensive — processPendingSyncQueue should never throw (it returns
      // a wrapped response), but if upstream contract changes we don't want
      // the cron to die silently.
      const error = err as Error;
      this.logger.error(`sync tick crashed: ${error.message}`, error.stack);
      captureException(error, { source: 'SyncQueueScheduler.tick' });
    } finally {
      this.running = false;
    }
  }

  /** Exposed for testing — checks the in-flight guard. */
  isRunning(): boolean {
    return this.running;
  }

  private batchSize(): number {
    const raw = this.config.get<number>('INTEGRATION_SYNC_BATCH_SIZE', 20);
    return Math.max(1, Math.min(500, Number(raw) || 20));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
