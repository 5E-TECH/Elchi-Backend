import { PartnerWebhookDigestScheduler } from './partner-webhook-digest.scheduler';

/** vy9gakYq — awaiting_config kunlik ogohlantirish scheduleri. */
describe('PartnerWebhookDigestScheduler', () => {
  const make = (cfg: Record<string, unknown> = {}) => {
    const integrationService = {
      digestAwaitingConfigPartnerWebhooks: jest.fn(() =>
        Promise.resolve({ total: 2, partners: [{}], notified: true }),
      ),
    };
    const scheduler = { addCronJob: jest.fn() };
    const config = {
      get: jest.fn((key: string, def: unknown) =>
        key in cfg ? cfg[key] : def,
      ),
    };
    const s = new PartnerWebhookDigestScheduler(
      integrationService as any,
      scheduler as any,
      config as any,
    );
    return { s, integrationService, scheduler };
  };

  it('yoqilgan: 09:00 Toshkent (04:00 UTC) cron ro`yxatga olinadi', () => {
    const { s, scheduler } = make();
    s.onModuleInit();
    expect(scheduler.addCronJob).toHaveBeenCalledWith(
      'integration.partner_webhook.digest',
      expect.anything(),
    );
    s.onModuleDestroy();
  });

  it('INTEGRATION_WEBHOOK_DIGEST_CRON_ENABLED=false — cron yo`q', () => {
    const { s, scheduler } = make({
      INTEGRATION_WEBHOOK_DIGEST_CRON_ENABLED: false,
    });
    s.onModuleInit();
    expect(scheduler.addCronJob).not.toHaveBeenCalled();
  });

  it('tick digest`ni chaqiradi; xato cron`ni o`ldirmaydi', async () => {
    const { s, integrationService } = make();
    await s.tick();
    expect(
      integrationService.digestAwaitingConfigPartnerWebhooks,
    ).toHaveBeenCalledTimes(1);

    integrationService.digestAwaitingConfigPartnerWebhooks.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(s.tick()).resolves.toBeUndefined();
  });
});
