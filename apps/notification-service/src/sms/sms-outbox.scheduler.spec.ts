import {
  SmsOutboxScheduler,
  SMS_OUTBOX_LOCK_NAME,
} from './sms-outbox.scheduler';
import { SmsConfigService } from './sms-config.service';
import { SmsGateService } from './sms-gate.service';
import { SmsProviderError } from './sms.port';

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    to_phone: '+998901234567',
    text: 't',
    message_class: 'transactional',
    client_message_id: `c-${id}`,
    sender_profile: 'default',
    attempts: 0,
    max_attempts: 3,
    ...extra,
  }) as never;

describe('SmsOutboxScheduler', () => {
  let outbox: {
    claimDue: jest.Mock;
    markAccepted: jest.Mock;
    markFailed: jest.Mock;
    releaseClaimed: jest.Mock;
    deferUntil: jest.Mock;
  };
  let adapter: { send: jest.Mock };
  let registry: { resolve: jest.Mock; callbackUrl: jest.Mock };
  let runner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
  let consent: { partition: jest.Mock };
  let locked: boolean;
  const make = (env: Record<string, unknown> = { SMS_ENABLED: 'true' }) => {
    const config = new SmsConfigService({
      get: (key: string) => env[key],
    } as never);
    return new SmsOutboxScheduler(
      config,
      outbox as never,
      registry as never,
      { addCronJob: jest.fn() } as never,
      { createQueryRunner: () => runner } as never,
      consent as never,
      new SmsGateService(config, {} as never),
    );
  };

  beforeEach(() => {
    locked = true;
    outbox = {
      claimDue: jest.fn().mockResolvedValue([row('1'), row('2')]),
      markAccepted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(false),
      releaseClaimed: jest.fn().mockResolvedValue(undefined),
      deferUntil: jest.fn().mockResolvedValue(undefined),
    };
    adapter = {
      send: jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'p', acceptedAt: new Date() }),
    };
    registry = {
      resolve: jest.fn().mockResolvedValue(adapter),
      callbackUrl: jest.fn().mockReturnValue(null),
    };
    consent = {
      partition: jest.fn().mockResolvedValue({ allowed: [{}], blocked: [] }),
    };
    runner = {
      connect: jest.fn(),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('pg_try_advisory_lock') ? [{ locked }] : [{}],
        ),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('takes its OWN advisory lock name and releases it', async () => {
    await make().tick();
    expect(runner.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [SMS_OUTBOX_LOCK_NAME],
    );
    expect(runner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1))',
      [SMS_OUTBOX_LOCK_NAME],
    );
    expect(SMS_OUTBOX_LOCK_NAME).not.toMatch(/integration/);
    expect(runner.release).toHaveBeenCalled();
  });

  it('a second replica that cannot get the lock processes nothing', async () => {
    locked = false;
    expect(await make().tick()).toBeNull();
    expect(outbox.claimDue).not.toHaveBeenCalled();
  });

  it('sends each claimed row and records the provider answer', async () => {
    const result = await make().tick();
    expect(result).toEqual({ processed: 2, sent: 2, failed: 0 });
    expect(outbox.markAccepted).toHaveBeenCalledTimes(2);
  });

  it('does not send queued promo when consent has since been revoked', async () => {
    outbox.claimDue.mockResolvedValue([
      row('1', { message_class: 'promo', customer_id: '7' }),
    ]);
    consent.partition.mockResolvedValue({ allowed: [], blocked: [{}] });
    // Tungi taqiq oynasi o'chiq (start = end): test soatga bog'liq bo'lmasin —
    // 18:00–09:00 da reklama rozilik tekshiruvigacha yetmay suriladi.
    const scheduler = make({
      SMS_ENABLED: 'true',
      NOTIF_PROMO_QUIET_HOURS: '00:00-00:00',
    });
    await scheduler.tick();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(outbox.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/rozilik/),
      false,
    );
  });

  it('provider errors go to markFailed with the retryable flag', async () => {
    adapter.send
      .mockRejectedValueOnce(new SmsProviderError('HTTP 503', true))
      .mockRejectedValueOnce(new SmsProviderError('bad number', false));
    outbox.markFailed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await make().tick();
    expect(outbox.markFailed.mock.calls[0][2]).toBe(true);
    expect(outbox.markFailed.mock.calls[1][2]).toBe(false);
    expect(result).toEqual({ processed: 2, sent: 0, failed: 1 });
  });

  it('kill-switch keeps the queue intact: nothing is claimed while SMS_ENABLED=false', async () => {
    await make({}).tick();
    expect(outbox.claimDue).not.toHaveBeenCalled();
  });

  it('a missing provider account is retryable (row is not burned)', async () => {
    registry.resolve.mockResolvedValue(null);
    await make().tick();
    expect(outbox.markFailed.mock.calls[0][1]).toMatch(/akkaunti sozlanmagan/);
    expect(outbox.markFailed.mock.calls[0][2]).toBe(true);
  });

  it('SMS_CRON_ENABLED=false: warns and registers no cron', () => {
    const scheduler = make({ SMS_ENABLED: 'true', SMS_CRON_ENABLED: 'false' });
    const warn = jest
      .spyOn(
        (scheduler as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation();
    scheduler.onModuleInit();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SMS_CRON_ENABLED=false'),
    );
  });

  it('shutdown waits for the in-flight tick to finish', async () => {
    let release!: () => void;
    adapter.send.mockReturnValueOnce(
      new Promise(
        (resolve) =>
          (release = () =>
            resolve({ providerMessageId: 'p', acceptedAt: new Date() })),
      ),
    );
    outbox.claimDue.mockResolvedValue([row('1')]);
    const scheduler = make();
    const tick = scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shutdown = scheduler.onModuleDestroy();
    setTimeout(() => release(), 150);
    await shutdown;
    await tick;
    expect(outbox.markAccepted).toHaveBeenCalledTimes(1);
  });

  it('(3fRbyadQ TC11) shutdown mid-batch: unsent claimed rows go back to pending WITHOUT burning an attempt', async () => {
    let release!: () => void;
    adapter.send.mockReturnValueOnce(
      new Promise(
        (resolve) =>
          (release = () =>
            resolve({ providerMessageId: 'p', acceptedAt: new Date() })),
      ),
    );
    outbox.claimDue.mockResolvedValue([row('1'), row('2'), row('3')]);
    const scheduler = make();
    const tick = scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shutdown = scheduler.onModuleDestroy();
    release();
    await shutdown;
    await tick;
    expect(outbox.markAccepted).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    // markFailed urinishni sarflardi (2 marta xato bergan qator nohaq terminal bo'lardi).
    expect(outbox.markFailed).not.toHaveBeenCalled();
    expect(outbox.releaseClaimed).toHaveBeenCalledWith(['2', '3']);
  });

  describe('(sVByLMnt #3) tungi taqiq YUBORISH paytida ham', () => {
    const tashkent = (iso: string) => new Date(`${iso}+05:00`);

    it('19:30 da navbatdan chiqqan reklama YUBORILMAYDI — ertangi 09:00 ga suriladi (urinish sarflanmaydi)', async () => {
      outbox.claimDue.mockResolvedValue([
        row('1', { message_class: 'promo' }),
        row('2', { message_class: 'transactional' }),
      ]);
      const result = await make().tick(tashkent('2026-10-14T19:30:00'));
      expect(outbox.deferUntil).toHaveBeenCalledWith(
        '1',
        tashkent('2026-10-15T09:00:00'),
      );
      // Faqat transaksion ketdi; reklama na yuborildi, na markFailed.
      expect(adapter.send).toHaveBeenCalledTimes(1);
      expect(adapter.send.mock.calls[0][0]).toMatchObject({
        clientMessageId: 'c-2',
      });
      expect(outbox.markFailed).not.toHaveBeenCalled();
      expect(consent.partition).not.toHaveBeenCalled();
      expect(result).toEqual({ processed: 2, sent: 1, failed: 0 });
    });

    it('10:00 da reklama darhol ketadi (rozilik qayta tekshiriladi)', async () => {
      outbox.claimDue.mockResolvedValue([row('1', { message_class: 'promo' })]);
      await make().tick(tashkent('2026-10-14T10:00:00'));
      expect(outbox.deferUntil).not.toHaveBeenCalled();
      expect(consent.partition).toHaveBeenCalled();
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    it('tungi OTP (security) taqiqqa tushmaydi', async () => {
      outbox.claimDue.mockResolvedValue([
        row('1', { message_class: 'security', sender_profile: 'otp' }),
      ]);
      await make().tick(tashkent('2026-10-14T02:00:00'));
      expect(outbox.deferUntil).not.toHaveBeenCalled();
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });
  });
});
