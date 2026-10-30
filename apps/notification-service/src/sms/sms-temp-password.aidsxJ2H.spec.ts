import { Logger } from '@nestjs/common';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import {
  NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN,
  NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
} from '@app/common';
import { SmsConfigService } from './sms-config.service';
import { SmsController } from './sms.controller';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';
import { SmsOutboxScheduler } from './sms-outbox.scheduler';
import {
  SmsDuplicateError,
  SmsOutboxService,
  scrubSmsSecret,
} from './sms-outbox.service';
import { SmsProviderError } from './sms.port';
import {
  DEFAULT_TEMP_PASSWORD_TEXT,
  SmsTempPasswordService,
  TEMP_PASSWORD_MASK,
  outboxFailureReason,
} from './sms-temp-password.service';

/**
 * (aidsxJ2H) Vaqtinchalik parol SMS'i: `security` sinfi, `user.temp_password`
 * shabloni, faqat `sms_outbox`; parol `text` da faqat yuborilguncha,
 * keyin `redacted_text` (••••) bilan almashtiriladi. Xato TASHLANMAYDI
 * (DLQ'ga parol tushmasin) — `status: failed` + sabab. Real SMS yo'q.
 */
const PASSWORD = 'Ab3dEf7hJk9m';
const CMID = 'tmppw-0b4f8a52-1111-2222-3333-444455556666';

describe('aidsxJ2H — SmsTempPasswordService', () => {
  let outbox: { enqueue: jest.Mock };
  let registry: { hasAccount: jest.Mock };
  let templates: { resolve: jest.Mock };
  let repo: { find: jest.Mock };
  const make = () =>
    new SmsTempPasswordService(
      outbox as never,
      registry as never,
      templates as never,
      repo as never,
    );
  const input = {
    phone: '+998935557711',
    password: PASSWORD,
    client_message_id: CMID,
    lang: 'uz',
  };

  beforeEach(() => {
    outbox = {
      enqueue: jest.fn().mockResolvedValue({
        queued: [{ id: '1' }],
        skipped: [],
        estimated_cost: null,
      }),
    };
    registry = {
      hasAccount: jest.fn((profile: string) =>
        Promise.resolve(profile === 'default'),
      ),
    };
    templates = { resolve: jest.fn().mockResolvedValue(null) };
    repo = { find: jest.fn().mockResolvedValue([]) };
  });

  it('security sinfi, shablon matni, redacted_text — parol faqat `text` da', async () => {
    templates.resolve.mockResolvedValue({
      code: 'user.temp_password',
      text: 'Elchi: login {{login}}, parol {{password}} .',
      required_vars: ['login', 'password'],
    });
    const result = await make().send(input);
    expect(result).toMatchObject({
      client_message_id: CMID,
      status: 'pending',
      failure_reason: null,
    });
    expect(templates.resolve).toHaveBeenCalledWith('user.temp_password', 'uz');
    const [[rows]] = outbox.enqueue.mock.calls as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows).toEqual([
      {
        to: '+998935557711',
        text: `Elchi: login +998935557711, parol ${PASSWORD} .`,
        redactedText: `Elchi: login +998935557711, parol ${TEMP_PASSWORD_MASK} .`,
        messageClass: 'security',
        templateCode: 'user.temp_password',
        senderProfile: 'default',
        clientMessageId: CMID,
      },
    ]);
    expect(String(rows[0].redactedText)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("shablon yo'q — dizayndagi standart matn (GSM-7, 1 bo'lak); 'otp' akkaunti bo'lsa o'sha", async () => {
    registry.hasAccount.mockResolvedValue(true);
    await make().send(input);
    const [[rows]] = outbox.enqueue.mock.calls as [
      [Array<Record<string, unknown>>],
    ];
    expect(rows[0]).toMatchObject({
      senderProfile: 'otp',
      text: DEFAULT_TEMP_PASSWORD_TEXT.replace(
        '{{login}}',
        '+998935557711',
      ).replace('{{password}}', PASSWORD),
    });
    expect(String(rows[0].text).length).toBeLessThanOrEqual(160);
  });

  it('akkaunt umuman yo‘q — failed provider_not_configured, navbatga hech narsa', async () => {
    registry.hasAccount.mockResolvedValue(false);
    await expect(make().send(input)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'provider_not_configured',
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('darvoza (SMS o‘chiq / kvota) — xato TASHLAMAYDI, failed + sabab', async () => {
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError('sms_disabled', "SMS o'chiq"),
    );
    await expect(make().send(input)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'sms_disabled',
    });
  });

  it("noto'g'ri raqam (skipped) — failed invalid_phone", async () => {
    outbox.enqueue.mockResolvedValue({
      queued: [],
      skipped: [{ to: '+99***', reason: 'invalid_phone' }],
      estimated_cost: 0,
    });
    await expect(make().send(input)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'invalid_phone',
    });
  });

  it('kutilmagan xato — failed internal_error, logda parol/matn YO‘Q', async () => {
    const logged: unknown[][] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    outbox.enqueue.mockRejectedValue(new Error(`boom ${PASSWORD}`));
    await expect(make().send(input)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'internal_error',
    });
    spy.mockRestore();
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it('takroriy client_message_id — mavjud qator holati qaytadi', async () => {
    outbox.enqueue.mockRejectedValue(new SmsDuplicateError([CMID]));
    repo.find.mockResolvedValue([
      {
        client_message_id: CMID,
        status: 'sent',
        last_error: null,
        created_at: new Date('2026-10-26T09:00:00Z'),
        sent_at: new Date('2026-10-26T09:00:04Z'),
        dlr_at: null,
      },
    ]);
    await expect(make().send(input)).resolves.toMatchObject({
      status: 'sent',
      sent_at: '2026-10-26T09:00:04.000Z',
    });
  });

  it("buzilgan so'rov (parol/ID formati) — failed invalid_request, navbatga hech narsa", async () => {
    await expect(
      make().send({ ...input, password: 'qisqa' }),
    ).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'invalid_request',
    });
    await expect(
      make().send({ ...input, client_message_id: 'otp-1' }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('holat: processing → pending, delivered — dlr_at, failed — mashina sababi (xom matn emas)', async () => {
    repo.find.mockResolvedValue([
      {
        client_message_id: 'tmppw-aaaaaaaa-1',
        status: 'processing',
        last_error: null,
        created_at: new Date('2026-10-26T09:00:00Z'),
        sent_at: null,
        dlr_at: null,
      },
      {
        client_message_id: 'tmppw-bbbbbbbb-2',
        status: 'delivered',
        last_error: null,
        created_at: new Date('2026-10-26T09:00:00Z'),
        sent_at: new Date('2026-10-26T09:00:03Z'),
        dlr_at: new Date('2026-10-26T09:00:06Z'),
      },
      {
        client_message_id: 'tmppw-cccccccc-3',
        status: 'failed',
        last_error: 'Eskiz: "Not enough balance"',
        created_at: new Date('2026-10-26T09:00:00Z'),
        sent_at: null,
        dlr_at: null,
      },
    ]);
    const states = await make().statuses([
      'tmppw-aaaaaaaa-1',
      'tmppw-bbbbbbbb-2',
      'tmppw-cccccccc-3',
      'notif-1',
    ]);
    expect(states).toEqual([
      expect.objectContaining({ status: 'pending', failure_reason: null }),
      expect.objectContaining({
        status: 'delivered',
        delivered_at: '2026-10-26T09:00:06.000Z',
      }),
      expect.objectContaining({
        status: 'failed',
        failure_reason: 'provider_rejected',
      }),
    ]);
    expect(JSON.stringify(states)).not.toContain('balance');
    // Faqat tmppw- id'lari so'raladi.
    expect(JSON.stringify(repo.find.mock.calls)).not.toContain('notif-1');
  });

  it('outboxFailureReason: DLR / tarmoq / akkaunt / qotgan', () => {
    expect(outboxFailureReason('DLR: UNDELIV')).toBe('not_delivered');
    expect(outboxFailureReason('Eskiz tarmoq xatosi: x')).toBe(
      'provider_unavailable',
    );
    expect(
      outboxFailureReason('SMS provayder akkaunti sozlanmagan (eskiz/otp)'),
    ).toBe('provider_not_configured');
    expect(outboxFailureReason('recovered: processing timed out')).toBe(
      'provider_unavailable',
    );
    expect(
      outboxFailureReason('staging_blocked: sms recipient not in allowlist'),
    ).toBe('staging_blocked');
  });

  it('SmsController: ikkala RMQ pattern ro‘yxatda', () => {
    const proto = SmsController.prototype as unknown as Record<string, unknown>;
    const cmds = Object.getOwnPropertyNames(proto).flatMap((name) => {
      const meta = Reflect.getMetadata(
        PATTERN_METADATA,
        proto[name] as object,
      ) as Array<{ cmd?: string }> | undefined;
      return (meta ?? []).map((pattern) => pattern?.cmd);
    });
    expect(cmds).toEqual(
      expect.arrayContaining([
        NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
        NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN,
      ]),
    );
  });
});

describe('aidsxJ2H — sms_outbox: parol yuborilgandan keyin DB’da qolmaydi', () => {
  const config = new SmsConfigService({
    get: (key: string) =>
      ({ SMS_ENABLED: 'true', SMS_DAILY_CAP: '500', SMS_MAX_FANOUT: '200' })[
        key
      ],
  } as never);
  let repo: { update: jest.Mock };
  let insert: jest.Mock;

  const make = () => {
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn(() => ({
        insert,
        count: jest.fn().mockResolvedValue(0),
      })),
    };
    return new SmsOutboxService(
      repo as never,
      {} as never,
      {
        transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)),
      } as never,
      config,
      new SmsGateService(config, {} as never),
      { partition: jest.fn(), appendOptOut: jest.fn() } as never,
    );
  };
  const row = (extra: Record<string, unknown> = {}) =>
    ({
      id: '9',
      status: 'processing',
      attempts: 0,
      retry_count: 0,
      max_attempts: 3,
      message_class: 'security',
      text: `parol: ${PASSWORD} .`,
      redacted_text: `parol: ${TEMP_PASSWORD_MASK} .`,
      notification_id: null,
      ...extra,
    }) as never;

  beforeEach(() => {
    repo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    insert = jest.fn((rows: unknown[]) =>
      Promise.resolve({
        identifiers: rows.map((_, index) => ({ id: String(index + 1) })),
      }),
    );
  });

  it('enqueue: redacted_text faqat security sinfida yoziladi', async () => {
    await make().enqueue([
      {
        to: '+998935557711',
        text: `parol: ${PASSWORD} .`,
        redactedText: `parol: ${TEMP_PASSWORD_MASK} .`,
        messageClass: 'security',
        clientMessageId: CMID,
      },
      {
        to: '+998935557712',
        text: 'Buyurtma yetkazildi',
        redactedText: 'e’tiborsiz',
        messageClass: 'transactional',
      },
    ]);
    const [[rows]] = insert.mock.calls as [[Array<Record<string, unknown>>]];
    expect(rows[0].redacted_text).toBe(`parol: ${TEMP_PASSWORD_MASK} .`);
    expect(rows[1].redacted_text).toBeNull();
  });

  it('provayder qabul qildi — text ••••, parol yo‘q', async () => {
    await make().markAccepted(row(), 'p-1', null);
    const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.text).toBe(`parol: ${TEMP_PASSWORD_MASK} .`);
    expect(JSON.stringify(patch)).not.toContain(PASSWORD);
  });

  it('terminal xato — text ••••; qayta urinishda (terminal emas) hali yuboriladigan matn qoladi', async () => {
    await make().markFailed(row({ attempts: 2 }), 'HTTP 500', true);
    expect((repo.update.mock.calls[0][1] as Record<string, unknown>).text).toBe(
      `parol: ${TEMP_PASSWORD_MASK} .`,
    );

    repo.update.mockClear();
    await make().markFailed(row({ attempts: 0 }), 'HTTP 500', true);
    expect(repo.update.mock.calls[0][1]).not.toHaveProperty('text');
  });

  it('provayder xatosi matnni aks ettirsa ham parol last_error / last_response ga tushmaydi', async () => {
    const echoed = `Eskiz: "Rad etildi: parol: ${PASSWORD} ."`;
    await make().markFailed(row({ attempts: 2 }), echoed, false, {
      message: echoed,
      nested: { text: `parol: ${PASSWORD} .` },
    });
    const patch = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(patch)).not.toContain(PASSWORD);
    expect(patch.last_error).toBe('Eskiz: "Rad etildi: parol: *** ."');
    expect(patch.last_response).toEqual({
      message: 'Eskiz: "Rad etildi: parol: *** ."',
      nested: { text: 'parol: *** .' },
    });

    repo.update.mockClear();
    await make().markAccepted(row(), 'p-1', { echo: PASSWORD });
    expect(JSON.stringify(repo.update.mock.calls[0][1])).not.toContain(
      PASSWORD,
    );
  });

  it('scrubSmsSecret: oddiy / allaqachon maskalangan qatorga tegmaydi', () => {
    const plain = { text: 'Kod: 123456', redacted_text: null };
    expect(scrubSmsSecret(plain, 'Kod: 123456')).toBe('Kod: 123456');
    const masked = { text: 'parol: **', redacted_text: 'parol: **' };
    expect(scrubSmsSecret(masked, 'parol: **')).toBe('parol: **');
  });

  it('scheduler: provayder xatosi logiga parol TUSHMAYDI', async () => {
    const warnings: unknown[][] = [];
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    const secretRow = row({
      to_phone: '+998935557711',
      client_message_id: CMID,
      sender_profile: 'otp',
    });
    const outbox = {
      claimDue: jest.fn().mockResolvedValue([secretRow]),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    const scheduler = new SmsOutboxScheduler(
      config,
      outbox as never,
      {
        resolve: jest.fn().mockResolvedValue({
          send: jest
            .fn()
            .mockRejectedValue(
              new SmsProviderError(`Eskiz: "${PASSWORD}"`, false, 400),
            ),
        }),
        callbackUrl: jest.fn().mockReturnValue(null),
      } as never,
      { addCronJob: jest.fn() } as never,
      {
        createQueryRunner: () => ({
          connect: jest.fn(),
          query: jest.fn().mockResolvedValue([{ locked: true }]),
          release: jest.fn().mockResolvedValue(undefined),
        }),
      } as never,
      { partition: jest.fn() } as never,
      new SmsGateService(config, {} as never),
    );
    await scheduler.tick();
    warn.mockRestore();
    expect(outbox.markFailed).toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(PASSWORD);
  });

  it('OTP qatori (redacted_text yo‘q) — eski raqam maskasi o‘zgarmagan', async () => {
    await make().markAccepted(
      row({ text: 'Kod: 123456', redacted_text: null }),
      'p-2',
      null,
    );
    expect((repo.update.mock.calls[0][1] as Record<string, unknown>).text).toBe(
      'Kod: ******',
    );
  });
});
