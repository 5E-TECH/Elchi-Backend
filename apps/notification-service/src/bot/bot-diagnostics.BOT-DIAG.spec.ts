import { Logger } from '@nestjs/common';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { NotificationServiceController } from '../notification-service.controller';
import {
  BOT_RECHECK_GETME_TIMEOUT_MS,
  BotRuntimeService,
  classifyTokenCheckError,
} from './bot-runtime.service';
import {
  BotTransportService,
  TELEGRAM_API_BASE,
  TelegramApiError,
  describeFetchFailure,
} from './bot-transport.service';

/**
 * BOT-DIAG-BE — «Tizim holati»: Telegram bot nosozligining ANIQ sababi
 * (faqat superadmin) va «Qayta tekshirish».
 *
 * Runtime HAQIQIY `BotTransportService` bilan quriladi (faqat `fetchImpl`
 * almashtiriladi): xato `callTelegramApi` → `TelegramApiError` → `describe`
 * yo'lidan o'tadi, prod'dagidek.
 */
const TOKEN = '7012345678:AAHq9ZsecretBotTokenValue_abcdefXYZ';
const SECRET_PART = TOKEN.split(':')[1];
const TELEGRAM_HOST = new URL(TELEGRAM_API_BASE).host;

const telegramResponse = (
  status: number,
  body: Record<string, unknown>,
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

const ok = (username = 'elchi_bot') =>
  telegramResponse(200, {
    ok: true,
    result: { id: 7012345678, is_bot: true, username },
  });

const fail = (status: number, description: string) =>
  telegramResponse(status, { ok: false, error_code: status, description });

/** undici `fetch failed` — asl sababi `cause.code` da. */
const fetchFailed = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`getaddrinfo ${code} ${TELEGRAM_HOST}`), {
      code,
    }),
  });

/** `AbortSignal.timeout` xatosi (DOMException `TimeoutError` ko'rinishi). */
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });

function makeRuntime(
  fetchImpl: jest.Mock,
  env: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: 'S3cret_token-for-telegram-0123456789',
  },
) {
  const config = { get: (key: string) => env[key] } as never;
  const transport = new BotTransportService(config);
  transport.fetchImpl = fetchImpl;
  transport.sleep = () => Promise.resolve();
  const runtime = new BotRuntimeService(
    config,
    transport,
    { dispatch: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { runtime, transport };
}

describe('BOT-DIAG-BE — getMe xatosi turlari (health() diagnostikasi)', () => {
  const NOW = new Date('2026-11-17T21:05:00.000Z');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tekshirilmagan: checked_at va xato maydonlari null, restart_required false', () => {
    const { runtime } = makeRuntime(jest.fn());
    expect(runtime.health()).toEqual({
      enabled: true,
      mode: 'webhook',
      healthy: null,
      username: null,
      reason: 'webhook (secret_token bilan)',
      checked_at: null,
      error_kind: null,
      error_status: null,
      error_text: null,
      restart_required: false,
    });
  });

  it.each([401, 404])(
    '⭐ %i → token_rejected, restart_required, mode off; status semantikasi o‘zgarmagan (degraded)',
    async (status) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          fail(status, status === 401 ? 'Unauthorized' : 'Not Found'),
        );
      const { runtime } = makeRuntime(fetchImpl);
      runtime.now = () => NOW;

      await runtime.checkToken();

      expect(runtime.health()).toEqual(
        expect.objectContaining({
          healthy: false,
          mode: 'off',
          checked_at: NOW.toISOString(),
          error_kind: 'token_rejected',
          error_status: status,
          error_text: expect.stringContaining(`(${status})`) as unknown,
          restart_required: true,
        }),
      );
      expect(runtime.isDegraded()).toBe(true);
      expect(runtime.acceptsWebhook()).toBe(false);
    },
  );

  it.each([
    ['ENOTFOUND', fetchFailed('ENOTFOUND')],
    ['ECONNREFUSED', fetchFailed('ECONNREFUSED')],
    ['ECONNRESET', fetchFailed('ECONNRESET')],
    ['EAI_AGAIN', fetchFailed('EAI_AGAIN')],
    ['fetch failed (sababsiz)', new TypeError('fetch failed')],
  ])('⭐ %s → network, status null, sabab matnda', async (label, error) => {
    const { runtime } = makeRuntime(jest.fn().mockRejectedValue(error));
    runtime.now = () => NOW;

    await expect(runtime.checkToken()).resolves.toBe(false);

    const health = runtime.health();
    expect(health).toEqual(
      expect.objectContaining({
        healthy: false,
        mode: 'webhook',
        checked_at: NOW.toISOString(),
        error_kind: 'network',
        error_status: null,
        restart_required: false,
      }),
    );
    expect(health.error_text).toContain('fetch failed');
    if (label !== 'fetch failed (sababsiz)') {
      expect(health.error_text).toContain(label);
    }
    expect(runtime.isDegraded()).toBe(true);
  });

  it('⭐ TimeoutError (AbortSignal.timeout) → timeout', async () => {
    const { runtime } = makeRuntime(
      jest.fn().mockRejectedValue(timeoutError()),
    );
    await runtime.checkToken();
    expect(runtime.health()).toEqual(
      expect.objectContaining({
        error_kind: 'timeout',
        error_status: null,
        error_text: expect.stringMatching(/aborted due to timeout/) as unknown,
      }),
    );
  });

  it.each([
    [500, 'Internal Server Error'],
    [502, 'Bad Gateway'],
    [429, 'Too Many Requests: retry after 5'],
  ])(
    '⭐ %i → telegram_error (status bilan), token rad etilmagan',
    async (status, description) => {
      const fetchImpl = jest.fn().mockResolvedValue(fail(status, description));
      const { runtime } = makeRuntime(fetchImpl);

      await runtime.checkToken();

      expect(runtime.health()).toEqual(
        expect.objectContaining({
          healthy: false,
          error_kind: 'telegram_error',
          error_status: status,
          error_text: expect.stringContaining(description) as unknown,
          restart_required: false,
        }),
      );
      // getMe — bitta urinish (retry/kutish yo'q).
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('⭐ muvaffaqiyatdan keyin xato maydonlari tozalanadi, checked_at yangilanadi', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(fetchFailed('ENOTFOUND'))
      .mockResolvedValueOnce(ok('elchi_bot'));
    const { runtime } = makeRuntime(fetchImpl);
    runtime.now = () => new Date('2026-11-17T21:00:00.000Z');
    await runtime.checkToken();
    expect(runtime.health().error_kind).toBe('network');

    runtime.now = () => NOW;
    await runtime.checkToken();

    expect(runtime.health()).toEqual(
      expect.objectContaining({
        healthy: true,
        username: 'elchi_bot',
        checked_at: NOW.toISOString(),
        error_kind: null,
        error_status: null,
        error_text: null,
        restart_required: false,
      }),
    );
    expect(runtime.isDegraded()).toBe(false);
  });

  it('⭐ error_text ≤ 200 belgi', async () => {
    const { runtime } = makeRuntime(
      jest.fn().mockResolvedValue(fail(500, 'x'.repeat(1_000))),
    );
    await runtime.checkToken();
    const text = runtime.health().error_text ?? '';
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith('…')).toBe(true);
  });

  it('⭐ token hech qayerda yo‘q: health() JSON, error_text va loglar', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const log = jest.spyOn(Logger.prototype, 'log');
    const cases = [
      // Xato matnida to'liq URL (token bilan) — eski undici / proksi xatosi.
      new Error(
        `request to ${TELEGRAM_API_BASE}/bot${TOKEN}/getMe failed, reason: connect ECONNREFUSED`,
      ),
      // Tokenning faqat o'zi (bot prefiksisiz) — aynan env tokeni bo'yicha.
      new Error(`bad token ${TOKEN} rejected`),
    ];
    for (const failure of cases) {
      const { runtime } = makeRuntime(jest.fn().mockRejectedValue(failure));
      await runtime.checkToken();
      const health = runtime.health();
      expect(health.error_kind).toBe('network');
      const json = JSON.stringify(health);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(SECRET_PART);
      expect(health.error_text).toContain('<redacted>');
    }
    // Telegram javobi tavsifida token (nazariy) — ham yashiriladi.
    const { runtime } = makeRuntime(
      jest.fn().mockResolvedValue(fail(500, `upstream bot${TOKEN} error`)),
    );
    await runtime.checkToken();
    expect(JSON.stringify(runtime.health())).not.toContain(SECRET_PART);

    const logged = [error, warn, log]
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map(String).join(' '))
      .join('\n');
    expect(logged).not.toContain(SECRET_PART);
  });

  it('token sozlanmagan: getMe chaqirilmaydi, diagnostika null', async () => {
    const fetchImpl = jest.fn();
    const { runtime } = makeRuntime(fetchImpl, {});
    await expect(runtime.checkToken()).resolves.toBe(false);
    const result = await runtime.recheck();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        enabled: false,
        mode: 'off',
        checked_at: null,
        error_kind: null,
        restart_required: false,
        rechecked: false,
      }),
    );
    expect(runtime.isDegraded()).toBe(false);
  });

  it('polling: getUpdates 401 ham token_rejected sifatida yoziladi', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          url.endsWith('/getMe')
            ? ok()
            : url.endsWith('/getWebhookInfo')
              ? telegramResponse(200, { ok: true, result: { url: '' } })
              : fail(401, 'Unauthorized'),
        ),
      );
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, BOT_POLLING_LEADER: true };
    const config = { get: (key: string) => env[key as keyof typeof env] };
    const transport = new BotTransportService(config);
    transport.fetchImpl = fetchImpl;
    const runtime = new BotRuntimeService(
      config as never,
      transport,
      { dispatch: jest.fn() } as never,
      {
        getPollOffset: jest.fn().mockResolvedValue(0),
        setPollOffset: jest.fn(),
      } as never,
      {} as never,
    );
    runtime.schedule = () => 0 as unknown as NodeJS.Timeout;
    await runtime.onApplicationBootstrap();
    await runtime.pollOnce();

    expect(runtime.health()).toEqual(
      expect.objectContaining({
        healthy: false,
        error_kind: 'token_rejected',
        error_status: 401,
        restart_required: true,
      }),
    );
  });
});

describe('BOT-DIAG-BE — recheck() («Qayta tekshirish»)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ token rad etilmagan: getMe HOZIR yurgiziladi, yangi holat qaytadi', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(fetchFailed('ENOTFOUND'))
      .mockResolvedValueOnce(ok());
    const { runtime } = makeRuntime(fetchImpl);
    await runtime.checkToken();
    expect(runtime.isDegraded()).toBe(true);

    const result = await runtime.recheck();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        healthy: true,
        error_kind: null,
        restart_required: false,
        rechecked: true,
      }),
    );
    expect(runtime.isDegraded()).toBe(false);
  });

  it('⭐ token rad etilgan (401): qayta TEKSHIRILMAYDI, restart_required: true', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fail(401, 'Unauthorized'));
    const { runtime } = makeRuntime(fetchImpl);
    await runtime.checkToken();

    const result = await runtime.recheck();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        healthy: false,
        error_kind: 'token_rejected',
        error_status: 401,
        restart_required: true,
        rechecked: false,
      }),
    );
  });

  it('⭐ qisqa timeout getMe signaliga uzatiladi → Telegram osilsa `timeout`', async () => {
    // Haqiqiy AbortSignal.timeout: fetch signal bekor qilinguncha osiladi.
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject((init.signal as AbortSignal).reason as Error),
          );
        }),
    );
    const { runtime } = makeRuntime(fetchImpl);

    const result = await runtime.recheck(30);

    expect(result).toEqual(
      expect.objectContaining({ error_kind: 'timeout', rechecked: true }),
    );
    expect(BOT_RECHECK_GETME_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it('⭐ ustma-ust tekshiruv: kech kelgan ESKI natija yangisini bosib ketmaydi', async () => {
    let failOld: (error: unknown) => void = () => undefined;
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockResolvedValueOnce(ok());
    const { runtime } = makeRuntime(fetchImpl);

    const periodic = runtime.checkToken();
    const result = await runtime.recheck();
    expect(result.healthy).toBe(true);

    failOld(fetchFailed('ECONNRESET'));
    await periodic;

    expect(runtime.health()).toEqual(
      expect.objectContaining({ healthy: true, error_kind: null }),
    );
  });
});

describe('BOT-DIAG-BE — xato turlari klassifikatori', () => {
  it.each([
    [
      new TelegramApiError('getMe', 401, 'Unauthorized', null),
      'token_rejected',
      401,
    ],
    [
      new TelegramApiError('getMe', 404, 'Not Found', null),
      'token_rejected',
      404,
    ],
    [
      new TelegramApiError('getMe', 0, 'fetch failed (ENOTFOUND)', null),
      'network',
      null,
    ],
    [
      new TelegramApiError(
        'getMe',
        0,
        'The operation was aborted due to timeout',
        null,
      ),
      'timeout',
      null,
    ],
    [
      new TelegramApiError('getMe', 500, 'Internal Server Error', null),
      'telegram_error',
      500,
    ],
    [
      new TelegramApiError('getMe', 429, 'Too Many Requests', null),
      'telegram_error',
      429,
    ],
    [timeoutError(), 'timeout', null],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'timeout', null],
    [
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      'network',
      null,
    ],
    [new Error('kutilmagan'), 'unknown', null],
  ])('%s → %s', (error, kind, status) => {
    expect(classifyTokenCheckError(error)).toEqual({ kind, status });
  });

  it('describeFetchFailure: cause.code qo‘shiladi, takrorlanmaydi', () => {
    expect(describeFetchFailure(fetchFailed('ENOTFOUND'))).toBe(
      'fetch failed (ENOTFOUND)',
    );
    expect(
      describeFetchFailure(
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
          cause: { code: 'ECONNREFUSED' },
        }),
      ),
    ).toBe('connect ECONNREFUSED 1.2.3.4:443');
    expect(describeFetchFailure(timeoutError())).toBe(
      'The operation was aborted due to timeout',
    );
    expect(describeFetchFailure('satr')).toBe('network error');
  });
});

describe('BOT-DIAG-BE — notification-service RMQ: notification.bot.recheck', () => {
  const context = {
    getChannelRef: () => ({ ack: jest.fn() }),
    getMessage: () => ({}),
  } as never;

  const controllerWith = (runtime: Record<string, unknown>) => {
    const rmq = { ack: jest.fn(), nackForError: jest.fn() };
    const controller = Object.create(
      NotificationServiceController.prototype,
    ) as NotificationServiceController;
    Object.assign(controller, { botRuntime: runtime, rmqService: rmq });
    return { controller, rmq };
  };

  it('pattern ro‘yxatda (notification.health yonida)', () => {
    const proto = NotificationServiceController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(PATTERN_METADATA, proto.recheckBot)).toEqual([
      { cmd: 'notification.bot.recheck' },
    ]);
    expect(Reflect.getMetadata(PATTERN_METADATA, proto.health)).toEqual([
      { cmd: 'notification.health' },
    ]);
  });

  it('⭐ javob: notification.health shakli + `rechecked`; status semantikasi o‘sha (isDegraded)', async () => {
    const bot = {
      enabled: true,
      mode: 'off',
      healthy: false,
      username: null,
      reason: 'getMe 401: token buzuq — bot ishga tushmadi',
      checked_at: '2026-11-17T21:05:00.000Z',
      error_kind: 'token_rejected',
      error_status: 401,
      error_text: 'Telegram getMe failed (401): Unauthorized',
      restart_required: true,
    };
    const recheck = jest.fn().mockResolvedValue({ ...bot, rechecked: false });
    const { controller, rmq } = controllerWith({
      recheck,
      isDegraded: () => true,
    });

    const reply = await controller.recheckBot(context);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({
      service: 'notification-service',
      status: 'degraded',
      bot,
      rechecked: false,
      timestamp: expect.any(String) as unknown,
    });
    expect(rmq.ack).toHaveBeenCalled();
  });

  it('notification.health ham yangi diagnostika maydonlarini beradi (runtime.health())', async () => {
    const { runtime } = makeRuntime(
      jest.fn().mockRejectedValue(fetchFailed('ENOTFOUND')),
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await runtime.checkToken();
    const { controller } = controllerWith(runtime as never);

    const reply = (await controller.health(context)) as {
      status: string;
      bot: Record<string, unknown>;
    };

    expect(reply.status).toBe('degraded');
    expect(reply.bot).toEqual(
      expect.objectContaining({
        error_kind: 'network',
        error_status: null,
        restart_required: false,
      }),
    );
    expect(JSON.stringify(reply)).not.toContain(SECRET_PART);
    jest.restoreAllMocks();
  });
});
