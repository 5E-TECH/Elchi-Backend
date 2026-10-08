import { ReconcileScheduler } from './reconcile.scheduler';
import type { IntegrationServiceService } from './integration-service.service';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ConfigService } from '@nestjs/config';

/**
 * Solishtiruvchi cron haydovchisi (DOZ6dtJn). Solishtirishning o'zi
 * `integration-service.work-mode.spec.ts` da. Bu yerda:
 *   1. Master env kaliti bo'yicha cron ulanadi (yoki yo'q).
 *   2. Ustma-ust tick'lar `running` bayrog'i bilan o'tkazib yuboriladi.
 *   3. `reconcileDueIntegrations` ichidagi xato tick'dan tashqariga chiqmaydi.
 */
describe('ReconcileScheduler', () => {
  const instances: ReconcileScheduler[] = [];
  let reconcileDueIntegrations: jest.Mock;
  let addCronJob: jest.Mock;

  afterEach(async () => {
    while (instances.length > 0) {
      await instances
        .pop()!
        .onModuleDestroy()
        .catch(() => undefined);
    }
  });

  function build(env: Record<string, unknown> = {}) {
    reconcileDueIntegrations = jest
      .fn()
      .mockResolvedValue({ data: { results: [] } });
    addCronJob = jest.fn();
    const values: Record<string, unknown> = {
      INTEGRATION_RECONCILE_CRON_ENABLED: true,
      INTEGRATION_RECONCILE_CRON_EXPR: '0 */15 * * * *',
      INTEGRATION_RECONCILE_BATCH_SIZE: 200,
      ...env,
    };
    const scheduler = new ReconcileScheduler(
      { reconcileDueIntegrations } as unknown as IntegrationServiceService,
      { addCronJob } as unknown as SchedulerRegistry,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          values[key] !== undefined ? values[key] : fallback,
        ),
      } as unknown as ConfigService,
    );
    instances.push(scheduler);
    return scheduler;
  }

  it('cron yoqiq bo`lsa ro`yxatga olinadi', () => {
    build().onModuleInit();
    expect(addCronJob).toHaveBeenCalledWith(
      'integration.reconcile.tick',
      expect.anything(),
    );
  });

  it('INTEGRATION_RECONCILE_CRON_ENABLED=false — cron ulanmaydi', () => {
    build({ INTEGRATION_RECONCILE_CRON_ENABLED: false }).onModuleInit();
    expect(addCronJob).not.toHaveBeenCalled();
  });

  it('⭐ ustma-ust tick o`tkazib yuboriladi (running bayrog`i)', async () => {
    const scheduler = build();
    let release!: () => void;
    reconcileDueIntegrations.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ data: { results: [] } });
      }),
    );

    const first = scheduler.tick();
    expect(scheduler.isRunning()).toBe(true);
    await scheduler.tick();
    release();
    await first;

    expect(reconcileDueIntegrations).toHaveBeenCalledTimes(1);
    expect(reconcileDueIntegrations).toHaveBeenCalledWith(200);
    expect(scheduler.isRunning()).toBe(false);
  });

  it('xato tick`dan tashqariga chiqmaydi', async () => {
    const scheduler = build();
    reconcileDueIntegrations.mockRejectedValueOnce(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(scheduler.isRunning()).toBe(false);
  });
});
