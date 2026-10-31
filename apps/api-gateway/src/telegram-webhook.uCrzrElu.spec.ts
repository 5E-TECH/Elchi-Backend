import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NEVER, of, throwError } from 'rxjs';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import {
  TELEGRAM_EMIT_TIMEOUT_MS,
  TELEGRAM_UPDATE_EVENT,
  TelegramWebhookController,
  secretMatches,
} from './telegram-webhook.controller';
import { TELEGRAM_UPDATE_EVENT as NOTIFICATION_SIDE_EVENT } from '../../notification-service/src/bot/bot-config';
import {
  TELEGRAM_BOT_COMMANDS,
  runTelegramSetup,
} from '../../../scripts/telegram-setup';

/**
 * uCrzrElu — long-polling → webhook:
 *  - `POST /telegram/webhook/:botSlug` @Public, YAGONA himoya — secret_token
 *    (timingSafeEqual); noto'g'ri/yo'q → 401, RMQ'ga HECH NIMA uzatilmaydi;
 *  - to'g'ri secret → brokerga uzatilgach 200 (ishlov kutilmaydi); RMQ xatosi /
 *    timeout → 503 (BOT-3d);
 *  - scripts/telegram-setup.ts `allowed_updates` da `my_chat_member`;
 *  - eski pollLoop hech bir faylda qolmagan.
 */
const SECRET = 'S3cret_token-for-telegram-0123456789';
const ROOT = join(__dirname, '../../..');

const makeController = (
  secret: string | undefined = SECRET,
  emitResult = of(undefined),
) => {
  const emit = jest.fn(() => emitResult);
  const controller = new TelegramWebhookController(
    { emit } as never,
    {
      get: (key: string) =>
        key === 'TELEGRAM_WEBHOOK_SECRET' ? secret : undefined,
    } as never,
  );
  return { controller, emit };
};

const req = (body: unknown) => ({ body, ip: '149.154.167.1' }) as never;
const update = { update_id: 77, message: { chat: { id: 1 }, text: '/start' } };

describe('uCrzrElu — Telegram webhook (gateway)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['noto‘g‘ri secret', 'wrong-secret-value-000000'],
    ['secret yo‘q', undefined],
    ['bo‘sh secret', ''],
    ['prefiks mos, uzunroq', `${SECRET}x`],
  ])('⭐ %s → 401, RMQ’ga hech narsa uzatilmaydi', async (_label, header) => {
    const { controller, emit } = makeController();
    await expect(
      controller.receive('elchi', header, req(update)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(emit).not.toHaveBeenCalled();
  });

  it('server sekreti sozlanmagan → har so‘rov 401 (fail-closed)', async () => {
    const { controller, emit } = makeController('');
    await expect(
      controller.receive('elchi', SECRET, req(update)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(emit).not.toHaveBeenCalled();
  });

  it('⭐ to‘g‘ri secret → brokerga uzatilgach {ok:true}; ishlov (handler) kutilmaydi', async () => {
    const { controller, emit } = makeController();
    await expect(
      controller.receive('elchi', SECRET, req(update)),
    ).resolves.toEqual({ ok: true });
    expect(emit).toHaveBeenCalledWith(
      { cmd: TELEGRAM_UPDATE_EVENT },
      { bot_slug: 'elchi', update },
    );
    // Gateway va notification-service bir xil hodisa nomini ishlatadi.
    expect(TELEGRAM_UPDATE_EVENT).toBe(NOTIFICATION_SIDE_EVENT);
  });

  it('⭐ BOT-3d: RMQ xatosi → 503 (Telegram qayta yuboradi, update jim yo‘qolmaydi)', async () => {
    const { controller } = makeController(
      SECRET,
      throwError(() => new Error('channel closed')),
    );
    await expect(
      controller.receive('elchi', SECRET, req(update)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('⭐ BOT-3d: broker osilib qolsa — chegaradan keyin 503 (cheksiz kutilmaydi)', async () => {
    jest.useFakeTimers();
    try {
      const { controller } = makeController(SECRET, NEVER);
      const pending = controller.receive('elchi', SECRET, req(update));
      const assertion = expect(pending).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await jest.advanceTimersByTimeAsync(TELEGRAM_EMIT_TIMEOUT_MS + 10);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('to‘g‘ri secret, yaroqsiz tana → 200, uzatilmaydi (Telegram qayta yubormasin)', async () => {
    const { controller, emit } = makeController();
    await expect(
      controller.receive('elchi', SECRET, req({ foo: 1 })),
    ).resolves.toEqual({ ok: true });
    await expect(
      controller.receive('Bad Slug!', SECRET, req(update)),
    ).resolves.toEqual({ ok: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it('⭐ timingSafeEqual ishlatiladi, oddiy `===` solishtiruv YO‘Q', () => {
    const src = readFileSync(
      join(__dirname, 'telegram-webhook.controller.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).toMatch(/timingSafeEqual\(/);
    expect(src).not.toMatch(
      /(secretHeader|provided|this\.secret|expected)\s*[!=]==/,
    );
    expect(src).not.toMatch(
      /[!=]==\s*(secretHeader|provided|this\.secret|expected)\b/,
    );
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
  });

  it('@Public (JWT yo‘q) va IP-throttle o‘chiq (Telegram IP’lari)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      TelegramWebhookController.prototype,
      'receive',
    )?.value as object;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    const skip = Reflect.getMetadataKeys(TelegramWebhookController).filter(
      (key) => String(key).toUpperCase().includes('THROTTLE'),
    );
    expect(skip.length).toBeGreaterThan(0);
  });
});

describe('uCrzrElu — scripts/telegram-setup.ts', () => {
  it('⭐ setWebhook: secret_token + allowed_updates ichida my_chat_member; setMyCommands; getWebhookInfo', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const call = jest.fn(
      (method: string, payload?: Record<string, unknown>) => {
        calls.push([method, payload]);
        if (method === 'getWebhookInfo') {
          return Promise.resolve({
            url: 'https://api.elchipochta.uz/telegram/webhook/elchi',
            pending_update_count: 0,
            allowed_updates: ['message', 'callback_query', 'my_chat_member'],
          });
        }
        return Promise.resolve(true);
      },
    );

    const result = await runTelegramSetup(call as never, {
      url: 'https://api.elchipochta.uz/telegram/webhook/elchi',
      secret: SECRET,
    });

    expect(calls.map(([method]) => method)).toEqual([
      'setWebhook',
      'setMyCommands',
      'getWebhookInfo',
    ]);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        url: 'https://api.elchipochta.uz/telegram/webhook/elchi',
        secret_token: SECRET,
        allowed_updates: expect.arrayContaining([
          'message',
          'callback_query',
          'my_chat_member',
        ]),
      }),
    );
    expect(calls[1][1]).toEqual({ commands: TELEGRAM_BOT_COMMANDS });
    expect(result.webhookUrl).toBe(
      'https://api.elchipochta.uz/telegram/webhook/elchi',
    );
  });

  it('https bo‘lmagan URL yoki zaif secret — Telegram’ga so‘rov KETMAYDI', async () => {
    const call = jest.fn();
    await expect(
      runTelegramSetup(call as never, {
        url: 'http://x.uz/hook',
        secret: SECRET,
      }),
    ).rejects.toThrow(/https/);
    await expect(
      runTelegramSetup(call as never, {
        url: 'https://x.uz/hook',
        secret: 'short',
      }),
    ).rejects.toThrow(/SECRET/);
    expect(call).not.toHaveBeenCalled();
  });

  it('getWebhookInfo da my_chat_member bo‘lmasa — xato (sozlama tekshiriladi)', async () => {
    const call = jest.fn((method: string) =>
      Promise.resolve(
        method === 'getWebhookInfo'
          ? { url: 'https://x.uz/hook', allowed_updates: ['message'] }
          : true,
      ),
    );
    await expect(
      runTelegramSetup(call as never, {
        url: 'https://x.uz/hook',
        secret: SECRET,
      }),
    ).rejects.toThrow(/my_chat_member|callback_query/);
  });
});

describe('uCrzrElu — eski pollLoop hech bir faylda qolmagan (grep-guard)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (['node_modules', 'dist', '.git', '.claude'].includes(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return name.endsWith('.ts') ? [path] : [];
    });

  it('⭐ `pollLoop` identifikatori apps/libs/scripts da YO‘Q', () => {
    const files = ['apps', 'libs', 'scripts'].flatMap((dir) =>
      walk(join(ROOT, dir)),
    );
    const offenders = files
      .filter((file) => file !== __filename)
      .filter((file) => /\bpollLoop\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
