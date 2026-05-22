import { SyncQueueScheduler } from './sync-queue.scheduler';
import type { IntegrationServiceService } from './integration-service.service';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ConfigService } from '@nestjs/config';
import type { ActivityLogService } from '@app/common';

/**
 * Tests for the cron driver — not for the queue processor itself (that's
 * IntegrationServiceService.processPendingSyncQueue, exercised separately).
 * We're verifying:
 *   1. Cron is wired (or not) per the master switch.
 *   2. Overlapping ticks are skipped via the in-flight guard.
 *   3. ActivityLog is only written when work actually happened.
 *   4. Crashes inside processPending* don't propagate out of tick().
 */
describe('SyncQueueScheduler', () => {
  let integrationService: jest.Mocked<
    Pick<IntegrationServiceService, 'processPendingSyncQueue'>
  >;
  let scheduler: jest.Mocked<
    Pick<SchedulerRegistry, 'addCronJob' | 'getCronJob'>
  >;
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let activityLog: jest.Mocked<Pick<ActivityLogService, 'log'>>;
  const instances: SyncQueueScheduler[] = [];

  afterEach(async () => {
    // Real CronJob instances created in onModuleInit hold setInterval handles;
    // stop them all so Jest doesn't warn about open handles.
    while (instances.length > 0) {
      const s = instances.pop()!;
      await s.onModuleDestroy().catch(() => undefined);
    }
  });

  function build(
    envOverrides: Record<string, unknown> = {},
  ): SyncQueueScheduler {
    const env: Record<string, unknown> = {
      INTEGRATION_SYNC_CRON_ENABLED: true,
      INTEGRATION_SYNC_CRON_EXPR: '*/30 * * * * *',
      INTEGRATION_SYNC_BATCH_SIZE: 20,
      ...envOverrides,
    };

    integrationService = {
      processPendingSyncQueue: jest.fn(),
    } as never;

    scheduler = {
      addCronJob: jest.fn(),
      getCronJob: jest.fn().mockReturnValue({ stop: jest.fn() }),
    } as never;

    config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        env[key] !== undefined ? env[key] : fallback,
      ),
    } as never;

    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
    } as never;

    const s = new SyncQueueScheduler(
      integrationService as never,
      scheduler as never,
      config as never,
      activityLog as never,
    );
    instances.push(s);
    return s;
  }

  describe('onModuleInit', () => {
    it('registers a cron job when the master switch is on', () => {
      const s = build();
      s.onModuleInit();
      expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
      const [name] = scheduler.addCronJob.mock.calls[0];
      expect(name).toBe('integration.sync-queue.tick');
    });

    it('does NOT register a cron job when disabled — manual trigger still works', () => {
      const s = build({ INTEGRATION_SYNC_CRON_ENABLED: false });
      s.onModuleInit();
      expect(scheduler.addCronJob).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('delegates to processPendingSyncQueue with the configured batch size', async () => {
      const s = build({ INTEGRATION_SYNC_BATCH_SIZE: 50 });
      integrationService.processPendingSyncQueue.mockResolvedValue({
        data: { processed: 0, completed: 0, failed: 0 },
      } as never);

      await s.tick();

      expect(integrationService.processPendingSyncQueue).toHaveBeenCalledWith(
        50,
      );
    });

    it('clamps batch size into the [1, 500] range', async () => {
      const s = build({ INTEGRATION_SYNC_BATCH_SIZE: 9999 });
      integrationService.processPendingSyncQueue.mockResolvedValue({
        data: { processed: 0 },
      } as never);

      await s.tick();

      expect(integrationService.processPendingSyncQueue).toHaveBeenCalledWith(
        500,
      );
    });

    it('writes an activity log entry only when items were processed', async () => {
      const s = build();
      integrationService.processPendingSyncQueue.mockResolvedValueOnce({
        data: { processed: 3, completed: 2, failed: 1 },
      } as never);

      await s.tick();
      expect(activityLog.log).toHaveBeenCalledTimes(1);
      const entry = activityLog.log.mock.calls[0][0];
      expect(entry.action).toBe('external_sync');
      expect(entry.entity_type).toBe('SyncQueue');
      expect(entry.metadata).toMatchObject({
        processed: 3,
        completed: 2,
        failed: 1,
      });

      // Quiet tick afterwards — no row should be written.
      activityLog.log.mockClear();
      integrationService.processPendingSyncQueue.mockResolvedValueOnce({
        data: { processed: 0 },
      } as never);
      await s.tick();
      expect(activityLog.log).not.toHaveBeenCalled();
    });

    it('skips a second concurrent tick — the in-flight guard prevents overlap', async () => {
      const s = build();
      let resolveFirst: (() => void) | undefined;
      integrationService.processPendingSyncQueue.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve({ data: { processed: 0 } } as never);
          }),
      );

      const first = s.tick();
      // While the first tick is still pending, fire a second.
      expect(s.isRunning()).toBe(true);
      await s.tick();
      // Second tick should have early-returned, not called the queue again.
      expect(integrationService.processPendingSyncQueue).toHaveBeenCalledTimes(
        1,
      );

      resolveFirst?.();
      await first;
      expect(s.isRunning()).toBe(false);
    });

    it('swallows errors from the queue processor — cron must not die', async () => {
      const s = build();
      integrationService.processPendingSyncQueue.mockRejectedValueOnce(
        new Error('partner API down'),
      );

      await expect(s.tick()).resolves.toBeUndefined();
      expect(s.isRunning()).toBe(false);

      // Following tick still runs.
      integrationService.processPendingSyncQueue.mockResolvedValueOnce({
        data: { processed: 0 },
      } as never);
      await s.tick();
      expect(integrationService.processPendingSyncQueue).toHaveBeenCalledTimes(
        2,
      );
    });

    it('does not run when shutting down', async () => {
      const s = build();
      await s.onModuleDestroy(); // sets shuttingDown=true
      await s.tick();
      expect(integrationService.processPendingSyncQueue).not.toHaveBeenCalled();
    });
  });
});
