import { Logger } from '@nestjs/common';
import { EskizAdapter } from './sms/adapters/eskiz.adapter';
import { PlayMobileAdapter } from './sms/adapters/playmobile.adapter';
import { SmsConfigService } from './sms/sms-config.service';
import { SmsGateService } from './sms/sms-gate.service';
import { SmsOutboxScheduler } from './sms/sms-outbox.scheduler';
import { SmsStagingBlockedError } from './sms/sms-staging.guard';
import {
  TelegramStagingBlockedError,
  callTelegramApi,
  callTelegramApiMultipart,
} from './bot/bot-transport.service';
import { isPermanentSendError } from './bot/bot-outbox.service';
import {
  ENV_BOT_TOKEN,
  makeFetch,
  makeOutbox,
  makeTransport,
} from './bot/testing/bot-kit-spec';
import { WebPushService } from './push/web-push.service';

const sendNotification = jest.fn();

jest.mock('web-push', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
  setVapidDetails: jest.fn(),
}));

/**
 * (staging-safe) APP_ENV=staging da SMS / Telegram / web push ENG PASTKI
 * transport qatlamida allowlist bilan to'siladi; production'da xatti-harakat
 * o'zgarmaydi. Har kanal: staging blok, staging ruxsat, production.
 */
const KEYS = [
  'APP_ENV',
  'STAGING_SMS_ALLOWLIST',
  'STAGING_TELEGRAM_CHAT_ALLOWLIST',
  'STAGING_PUSH_USER_ALLOWLIST',
] as const;
const saved: Partial<Record<(typeof KEYS)[number], string>> = {};

const setEnv = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
};

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key];
});

afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});

afterEach(() => jest.restoreAllMocks());

const ALLOWED_PHONE = '+998901234567';
const OTHER_PHONE = '+998977776655';

const httpJson = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const smsInput = (to: string) => ({
  to,
  text: 'Buyurtma yetkazildi',
  messageClass: 'transactional' as const,
  clientMessageId: 'notif-1',
});

describe('SMS — adapter darajasida (Eskiz, Play Mobile)', () => {
  const creds = { login: 'ops@elchi.uz', password: 'p', sender: 'ELCHI' };
  const eskizFetch = () =>
    jest
      .fn()
      .mockResolvedValueOnce(httpJson(200, { data: { token: 'tok' } }))
      .mockResolvedValue(httpJson(200, { id: 'esk-1' }));

  it('staging: allowlist‘dan tashqari raqam — Eskiz‘ga login ham, send ham YO‘Q', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_SMS_ALLOWLIST: ALLOWED_PHONE });
    const fetchMock = eskizFetch();
    const adapter = new EskizAdapter(
      creds,
      fetchMock as never,
      'https://e/api',
    );
    const error = await adapter.send(smsInput(OTHER_PHONE)).catch((e) => e);
    expect(error).toBeInstanceOf(SmsStagingBlockedError);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/^staging_blocked: .*\(skipped\)$/);
    expect(error.message).not.toContain('977776655');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staging: bo‘sh allowlist — FAIL-CLOSED (hech kimga)', async () => {
    setEnv({ APP_ENV: 'staging' });
    const fetchMock = jest.fn();
    const adapter = new PlayMobileAdapter(
      creds,
      fetchMock as never,
      'https://p',
    );
    await expect(adapter.send(smsInput(ALLOWED_PHONE))).rejects.toThrow(
      /STAGING_SMS_ALLOWLIST bo'sh/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staging: allowlist‘dagi raqam (boshqa yozuvda) — yuboriladi', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_SMS_ALLOWLIST: '90 123 45 67' });
    const fetchMock = eskizFetch();
    const adapter = new EskizAdapter(
      creds,
      fetchMock as never,
      'https://e/api',
    );
    await expect(adapter.send(smsInput(ALLOWED_PHONE))).resolves.toMatchObject({
      providerMessageId: 'esk-1',
    });
    const play = jest.fn().mockResolvedValue(httpJson(200, {}));
    await new PlayMobileAdapter(creds, play as never, 'https://p').send(
      smsInput(ALLOWED_PHONE),
    );
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('production (APP_ENV yo‘q): allowlist‘siz ham yuboriladi — o‘zgarishsiz', async () => {
    setEnv({});
    const fetchMock = eskizFetch();
    const adapter = new EskizAdapter(
      creds,
      fetchMock as never,
      'https://e/api',
    );
    await adapter.send(smsInput(OTHER_PHONE));
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + send
  });

  it('scheduler: bloklangan qator darhol TERMINAL, last_error = aniq sabab', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_SMS_ALLOWLIST: ALLOWED_PHONE });
    const fetchMock = jest.fn();
    const outbox = {
      claimDue: jest.fn().mockResolvedValue([
        {
          id: '1',
          to_phone: OTHER_PHONE,
          text: 't',
          message_class: 'transactional',
          client_message_id: 'c-1',
          sender_profile: 'default',
          attempts: 0,
          max_attempts: 3,
        },
      ]),
      markAccepted: jest.fn(),
      markFailed: jest.fn().mockResolvedValue(true),
      releaseClaimed: jest.fn(),
      deferUntil: jest.fn(),
    };
    const registry = {
      resolve: jest
        .fn()
        .mockResolvedValue(new EskizAdapter(creds, fetchMock as never)),
      callbackUrl: jest.fn().mockReturnValue(null),
    };
    const config = new SmsConfigService({
      get: (key: string) => ({ SMS_ENABLED: 'true' })[key],
    } as never);
    const runner = {
      connect: jest.fn(),
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('pg_try') ? [{ locked: true }] : [{}]),
      ),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = new SmsOutboxScheduler(
      config,
      outbox as never,
      registry as never,
      { addCronJob: jest.fn() } as never,
      { createQueryRunner: () => runner } as never,
      { partition: jest.fn() } as never,
      new SmsGateService(config, {} as never),
    );
    await expect(scheduler.tick()).resolves.toEqual({
      processed: 1,
      sent: 0,
      failed: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outbox.markAccepted).not.toHaveBeenCalled();
    const [, reason, retryable] = outbox.markFailed.mock.calls[0];
    expect(reason).toMatch(/^staging_blocked: .*STAGING_SMS_ALLOWLIST/);
    expect(retryable).toBe(false);
  });
});

describe('Telegram — callTelegramApi / transport darajasida', () => {
  it('staging: allowlist‘da yo‘q chat — sendMessage HTTP‘ga chiqmaydi', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_TELEGRAM_CHAT_ALLOWLIST: '42' });
    const fetchMock = makeFetch();
    const error = await callTelegramApi(
      ENV_BOT_TOKEN,
      'sendMessage',
      { chat_id: '777', text: 'salom' },
      { fetchImpl: fetchMock as never },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TelegramStagingBlockedError);
    expect(error.kind).toBe('bad_request'); // 403 EMAS — kanal nofaol qilinmaydi
    expect(isPermanentSendError(error)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staging: multipart (sendDocument/sendPhoto) ham to‘siladi', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_TELEGRAM_CHAT_ALLOWLIST: '42' });
    const fetchMock = makeFetch();
    const form = new FormData();
    form.append('chat_id', '-100999');
    await expect(
      callTelegramApiMultipart(ENV_BOT_TOKEN, 'sendDocument', form, {
        fetchImpl: fetchMock as never,
      }),
    ).rejects.toBeInstanceOf(TelegramStagingBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staging: bo‘sh allowlist — guruhga ham, DM‘ga ham yo‘q; chat_id siz metod (getMe) — o‘tadi', async () => {
    setEnv({ APP_ENV: 'staging' });
    const fetchMock = makeFetch();
    const transport = makeTransport(fetchMock);
    await expect(transport.sendMessage('-100555', 'x')).rejects.toThrow(
      /STAGING_TELEGRAM_CHAT_ALLOWLIST bo'sh/,
    );
    await expect(transport.editMessage('42', 5, { text: 'y' })).resolves.toBe(
      false,
    );
    await expect(
      transport.sendMedia('42', [
        { buffer: Buffer.from('a'), mime: 'application/pdf', name: 'r.pdf' },
      ]),
    ).rejects.toBeInstanceOf(TelegramStagingBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
    await transport.getMe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('staging: allowlist‘dagi chat — yuboriladi', async () => {
    setEnv({
      APP_ENV: 'staging',
      STAGING_TELEGRAM_CHAT_ALLOWLIST: '42, -100555',
    });
    const fetchMock = makeFetch();
    const transport = makeTransport(fetchMock);
    await transport.sendMessage('42', 'a');
    await transport.sendMessage('-100555', 'b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('staging: outbox qatori darhol dead, qayta urinilmaydi, kanal nofaol QILINMAYDI', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_TELEGRAM_CHAT_ALLOWLIST: '42' });
    const fetchMock = makeFetch();
    const { outbox, repo, channels } = makeOutbox(fetchMock);
    const result = await outbox.send({
      chatId: '777',
      text: 'eslatma',
      source: 'test',
    });
    expect(result.status).toBe('dead');
    expect(result.error).toMatch(/staging_blocked/);
    expect([...repo.rows.values()][0].status).toBe('dead');
    expect(channels.markInactive).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('production: allowlist‘siz ham yuboriladi — o‘zgarishsiz', async () => {
    setEnv({});
    const fetchMock = makeFetch();
    const { outbox } = makeOutbox(fetchMock);
    await expect(
      outbox.send({ chatId: '777', text: 'x', source: 'test' }),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Web push — WebPushService.sendToSubscriptions', () => {
  const VAPID = {
    VAPID_PUBLIC_KEY: 'BPUBLIC-key-for-tests',
    VAPID_PRIVATE_KEY: 'private-key-for-tests',
    VAPID_SUBJECT: 'mailto:admin@elchipochta.uz',
  };
  const payload = {
    id: '1',
    title: 'Yangi buyurtma',
    body: null,
    link: null,
    type: 'order.new',
    priority: 'normal',
    tag: 'n-1',
  };
  const sub = (id: string, userId: string) =>
    ({
      id,
      user_id: userId,
      endpoint: `https://push.example/${id}`,
      p256dh: 'p',
      auth: 'a',
    }) as never;
  let repo: { find: jest.Mock; update: jest.Mock; delete: jest.Mock };

  const build = () => {
    const service = new WebPushService(
      { get: (key: string) => (VAPID as Record<string, string>)[key] } as never,
      repo as never,
    );
    service.onModuleInit();
    return service;
  };

  beforeEach(() => {
    sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
  });

  it('staging: allowlist‘da yo‘q foydalanuvchi — push YO‘Q, sabab qaytadi, DB‘ga tegilmaydi', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_PUSH_USER_ALLOWLIST: '25' });
    const result = await build().sendToSubscriptions(
      [sub('1', '99'), sub('2', '99')],
      payload,
    );
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sent: 0,
      failed: 2,
      retryable: false,
      staging_blocked: 2,
    });
    expect(result.error).toMatch(
      /^staging_blocked: .*STAGING_PUSH_USER_ALLOWLIST/,
    );
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('staging: bo‘sh allowlist — FAIL-CLOSED', async () => {
    setEnv({ APP_ENV: 'staging' });
    const result = await build().sendToSubscriptions([sub('1', '25')], payload);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result.error).toMatch(/bo'sh/);
  });

  it('staging: allowlist‘dagi foydalanuvchi — yuboriladi (aralash ro‘yxatda faqat u)', async () => {
    setEnv({ APP_ENV: 'staging', STAGING_PUSH_USER_ALLOWLIST: '25,26' });
    const result = await build().sendToSubscriptions(
      [sub('1', '25'), sub('2', '99')],
      payload,
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0].endpoint).toBe(
      'https://push.example/1',
    );
    expect(result).toMatchObject({ sent: 1, failed: 0, staging_blocked: 1 });
  });

  it('production: hamma obunaga — o‘zgarishsiz (staging_blocked kaliti yo‘q)', async () => {
    setEnv({});
    const result = await build().sendToSubscriptions(
      [sub('1', '25'), sub('2', '99')],
      payload,
    );
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      sent: 2,
      failed: 0,
      gone: 0,
      error: null,
      retryable: false,
    });
  });
});
