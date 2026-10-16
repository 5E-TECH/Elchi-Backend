import { Logger } from '@nestjs/common';
import { BotActionsService } from './bot-actions.service';
import { resolveBotConfig } from './bot-config';
import { BotRuntimeService } from './bot-runtime.service';
import { BotController } from './bot.controller';
import {
  TelegramApiError,
  assertCallbackDataFits,
} from './bot-transport.service';
import type { BotActionHandler } from './handlers/bot-context';
import {
  callbackUpdate,
  makeFetch,
  makeOutbox,
  makeRouter,
  makeTransport,
  telegramResponse,
  textUpdate,
  okResponse,
} from './testing/bot-kit-spec';

/**
 * Mvx0h1Fv — bot transport poydevori: webhook, DB sessiya, rate-limit,
 * eski 2 bot inventarizatsiyasi (ZlpXb4Wh spec'ida). Postgres qismi —
 * bot-core.pg.spec.ts.
 */
const TOKEN = '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa';
const SECRET = 'S3cret_token-for-telegram-0123456789';

const makeRuntime = (
  env: Record<string, unknown>,
  transport: Partial<
    Record<'getMe' | 'getUpdates' | 'getWebhookInfo', jest.Mock>
  > = {},
) => {
  const fakeTransport = {
    getMe:
      transport.getMe ??
      jest
        .fn()
        .mockResolvedValue({ id: 1, is_bot: true, username: 'elchi_bot' }),
    getUpdates: transport.getUpdates ?? jest.fn().mockResolvedValue([]),
    getWebhookInfo:
      transport.getWebhookInfo ?? jest.fn().mockResolvedValue({ url: '' }),
    describe: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  };
  const router = { dispatch: jest.fn().mockResolvedValue('done') };
  const sessions = {
    getPollOffset: jest.fn().mockResolvedValue(0),
    setPollOffset: jest.fn().mockResolvedValue(undefined),
  };
  const runtime = new BotRuntimeService(
    { get: (key: string) => env[key] } as never,
    fakeTransport as never,
    router as never,
    sessions as never,
    {} as never,
  );
  // Polling sikli testda o'z-o'zidan aylanmasin.
  const scheduled: number[] = [];
  runtime.schedule = ((_fn: () => void, ms: number) => {
    scheduled.push(ms);
    return 0 as unknown as NodeJS.Timeout;
  }) as never;
  return { runtime, transport: fakeTransport, router, sessions, scheduled };
};

describe('Mvx0h1Fv — bot rejimi va token sog‘ligi', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rejim tanlovi: token+secret → webhook; token yo‘q/placeholder → off; polling faqat leader', () => {
    expect(
      resolveBotConfig(
        (k) =>
          ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET })[k],
      ).mode,
    ).toBe('webhook');
    expect(
      resolveBotConfig((k) => ({ TELEGRAM_BOT_TOKEN: 'replace_me' })[k]).mode,
    ).toBe('off');
    expect(resolveBotConfig(() => undefined).mode).toBe('off');
    expect(
      resolveBotConfig((k) => ({ TELEGRAM_BOT_TOKEN: TOKEN })[k]).mode,
    ).toBe('off');
    expect(
      resolveBotConfig(
        (k) => ({ TELEGRAM_BOT_TOKEN: TOKEN, BOT_POLLING_LEADER: true })[k],
      ).mode,
    ).toBe('polling');
    expect(
      resolveBotConfig(
        (k) => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_MODE: 'webhook' })[k],
      ).mode,
    ).toBe('off');
  });

  it('⭐ setWebhook (webhook rejimi) → getUpdates HECH QACHON chaqirilmaydi', async () => {
    const ctx = makeRuntime({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      BOT_POLLING_LEADER: true,
    });
    await ctx.runtime.onApplicationBootstrap();
    expect(ctx.transport.getMe).toHaveBeenCalledTimes(1);
    expect(ctx.transport.getUpdates).not.toHaveBeenCalled();
    expect(ctx.runtime.acceptsWebhook()).toBe(true);
  });

  it('⭐ polling rejimi, lekin webhook o‘rnatilgan → polling ishga tushmaydi (ikki transport yonma-yon emas)', async () => {
    const ctx = makeRuntime(
      { TELEGRAM_BOT_TOKEN: TOKEN, BOT_POLLING_LEADER: '1' },
      {
        getWebhookInfo: jest.fn().mockResolvedValue({
          url: 'https://api.elchipochta.uz/telegram/webhook/elchi',
        }),
      },
    );
    await ctx.runtime.onApplicationBootstrap();
    expect(ctx.transport.getUpdates).not.toHaveBeenCalled();
    expect(ctx.runtime.acceptsWebhook()).toBe(false);
    expect(ctx.runtime.health().reason).toMatch(/webhook/);
  });

  it.each([404, 401])(
    '⭐ buzuq token (getMe %i) → poll/webhook ishga tushmaydi, readiness qizil, log BIR marta',
    async (status) => {
      const getMe = jest
        .fn()
        .mockRejectedValue(
          new TelegramApiError('getMe', status, 'Not Found', null),
        );
      const ctx = makeRuntime(
        { TELEGRAM_BOT_TOKEN: TOKEN, BOT_POLLING_LEADER: true },
        { getMe },
      );
      await ctx.runtime.onApplicationBootstrap();
      await ctx.runtime.checkToken();
      await ctx.runtime.checkToken();

      expect(ctx.transport.getUpdates).not.toHaveBeenCalled();
      expect(ctx.runtime.acceptsWebhook()).toBe(false);
      expect(ctx.runtime.isDegraded()).toBe(true);
      expect(ctx.runtime.health()).toEqual(
        expect.objectContaining({ enabled: true, healthy: false, mode: 'off' }),
      );
      // Token rad etilgandan keyin qayta getMe ham, qayta log ham yo'q.
      expect(getMe).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  it('token umuman yo‘q — bot o‘chiq, readiness’ga ta’sir YO‘Q (deploy yiqilmaydi)', async () => {
    const ctx = makeRuntime({});
    await ctx.runtime.onApplicationBootstrap();
    expect(ctx.transport.getMe).not.toHaveBeenCalled();
    expect(ctx.runtime.isDegraded()).toBe(false);
    expect(ctx.runtime.health()).toEqual(
      expect.objectContaining({ enabled: false, mode: 'off' }),
    );
  });
});

describe('Mvx0h1Fv — sessiya va tugmalar DB’dan tiklanadi', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** `telegram_bot_actions` — servis nusxalaridan tashqarida (DB o'rnida). */
  const makeStore = () => {
    const rows = new Map<string, Record<string, any>>();
    return {
      rows,
      insert: jest.fn((row: Record<string, any>) => {
        rows.set(row.action_id, { ...row });
        return Promise.resolve({});
      }),
      findOne: jest.fn(({ where }: { where: { action_id: string } }) =>
        Promise.resolve(rows.get(where.action_id) ?? null),
      ),
      createQueryBuilder: () => {
        let id = '';
        const builder = {
          update: () => builder,
          set: () => builder,
          where: (_sql: string, params: { actionId: string }) => {
            id = params.actionId;
            return builder;
          },
          execute: () => {
            const row = rows.get(id);
            if (!row || row.consumed_at || row.expires_at <= new Date()) {
              return Promise.resolve({ affected: 0 });
            }
            row.consumed_at = new Date();
            return Promise.resolve({ affected: 1 });
          },
        };
        return builder;
      },
    };
  };

  it('⭐ "restart"dan keyin oldingi karta tugmasi ishlaydi (holat DB’dan)', async () => {
    const store = makeStore();
    const callbackData = await new BotActionsService(store as never).create({
      chatId: '111',
      action: 'preview.confirm',
      actorUserId: '37',
      payload: { draft_id: '9' },
    });

    // Yangi jarayon: yangi servis va router nusxalari, faqat "DB" umumiy.
    const handled: Array<Record<string, unknown>> = [];
    const handler: BotActionHandler = {
      action: 'preview.confirm',
      handle: (_ctx, action) => {
        handled.push(action.payload);
        return Promise.resolve();
      },
    };
    const actions = new BotActionsService(store as never);
    const ctx = makeRouter({
      actor: {
        user_id: '37',
        role: 'market',
        status: 'active',
        market_id: '37',
        region_id: null,
      },
      actionHandlers: [handler],
      lookup: jest.fn((data: string) => actions.lookup(data)),
      consume: jest.fn((id: string) => actions.consume(id)),
    });
    await ctx.router.dispatch('elchi', callbackUpdate(callbackData));

    expect(handled).toEqual([{ draft_id: '9' }]);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenCalledWith('cb1');
  });

  it('⭐ callback_data 64 baytdan oshmaydi (qisqa id); uzun payload rad etiladi', async () => {
    const store = makeStore();
    const data = await new BotActionsService(store as never).create({
      chatId: '111',
      action: 'order.sold',
      payload: {
        order_ids: Array.from({ length: 50 }, (_, i) => String(1_251_145 + i)),
      },
    });
    expect(data).toMatch(/^a:[A-Za-z0-9_-]{16}$/);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);

    const long = 'x'.repeat(65);
    expect(() =>
      assertCallbackDataFits({
        inline_keyboard: [[{ text: 'a', callback_data: long }]],
      }),
    ).toThrow(/64/);
    // Ko'p baytli belgilar BAYT bo'yicha sanaladi.
    expect(() =>
      assertCallbackDataFits({
        inline_keyboard: [[{ text: 'a', callback_data: 'ў'.repeat(33) }]],
      }),
    ).toThrow(/64/);
    const { outbox } = makeOutbox(makeFetch());
    await expect(
      outbox.send({
        chatId: '1',
        text: 'x',
        reply_markup: {
          inline_keyboard: [[{ text: 'a', callback_data: long }]],
        },
        source: 'test',
      }),
    ).rejects.toThrow(/64/);
  });
});

describe('Mvx0h1Fv — rate-limit va 429', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ bitta chatdan 50 update/daqiqa → ortiqchasi JIM tashlanadi, bot javob berishda davom etadi', async () => {
    const ctx = makeRouter();
    const results: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      results.push(
        await ctx.router.dispatch(
          'elchi',
          textUpdate('salom', { updateId: i }),
        ),
      );
    }
    expect(results.filter((r) => r === 'done')).toHaveLength(20);
    expect(results.filter((r) => r === 'dropped')).toHaveLength(30);
    // Tashlanganlarga javob YO'Q (limit amplifikator bo'lmaydi).
    expect(ctx.outbox.send).toHaveBeenCalledTimes(20);
    // Boshqa chat — javob oladi.
    await ctx.router.dispatch('elchi', textUpdate('salom', { chatId: 222 }));
    expect(ctx.outbox.send).toHaveBeenCalledTimes(21);
  });

  it('⭐ 429 + retry_after → transport kutib qayta yuboradi, xabar yo‘qolmaydi', async () => {
    const fetchMock = makeFetch();
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse(429, {
          ok: false,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
      )
      .mockResolvedValueOnce(okResponse({ message_id: 5 }));
    const transport = makeTransport(fetchMock);

    const result = await transport.sendMessage('-100555', 'salom');

    expect(transport.sleep).toHaveBeenCalledWith(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ message_id: 5 });
  });

  it('⭐ outbox yo‘lida 429 → navbatda (queued), keyin yuboriladi', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValueOnce(
      telegramResponse(429, {
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: 3 },
      }),
    );
    const { outbox, repo } = makeOutbox(fetchMock);
    const first = await outbox.send({
      chatId: '-100555',
      text: 'salom',
      source: 'test',
    });
    expect(first.status).toBe('queued');
    const row = repo.rows.get(first.id)!;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
    expect(row.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(2_000);

    row.next_attempt_at = new Date(Date.now() - 1);
    expect(await outbox.processDue()).toBe(1);
    expect(repo.rows.get(first.id)!.status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Mvx0h1Fv — webhook hodisasi (BotController) va token tekshiruvi', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const webhookEnv = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
  };
  const event = {
    bot_slug: 'elchi',
    update: { update_id: 7, message: { chat: { id: 1 }, text: '/start' } },
  };
  const makeController = (runtime: BotRuntimeService) => {
    const router = { dispatch: jest.fn().mockResolvedValue('done') };
    const rmq = { ack: jest.fn() };
    const controller = new BotController(
      rmq as never,
      runtime,
      router as never,
      { firstSeen: jest.fn().mockResolvedValue(true) } as never,
    );
    return { controller, router, rmq };
  };

  it('⭐ getMe tugamasdan kelgan update kutadi va ishlanadi (deploy paytida yo‘qolmaydi)', async () => {
    let resolveGetMe!: (value: unknown) => void;
    const getMe = jest.fn(
      () => new Promise((resolve) => (resolveGetMe = resolve)),
    );
    const { runtime } = makeRuntime(webhookEnv, { getMe });
    const { controller, router, rmq } = makeController(runtime);

    const handling = controller.onTelegramUpdate(event as never, {} as never);
    await Promise.resolve();
    expect(router.dispatch).not.toHaveBeenCalled();
    resolveGetMe({ id: 1, is_bot: true, username: 'elchi_bot' });
    await handling;

    expect(getMe).toHaveBeenCalledTimes(1);
    expect(router.dispatch).toHaveBeenCalledWith('elchi', event.update);
    expect(rmq.ack).toHaveBeenCalledTimes(1);
    // Bootstrap ham o'sha tekshiruvdan foydalanadi — ikkinchi getMe yo'q.
    await runtime.onApplicationBootstrap();
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('getMe vaqtinchalik (tarmoq) xatosi — update’lar tashlanmaydi, readiness qizil', async () => {
    const getMe = jest
      .fn()
      .mockRejectedValue(new TelegramApiError('getMe', 0, 'ECONNRESET', null));
    const { runtime } = makeRuntime(webhookEnv, { getMe });
    const { controller, router } = makeController(runtime);
    await controller.onTelegramUpdate(event as never, {} as never);
    expect(router.dispatch).toHaveBeenCalledTimes(1);
    expect(runtime.isDegraded()).toBe(true);
  });

  it('⭐ token rad etilgan (404) — webhook update ishlanmaydi, lekin ack qilinadi', async () => {
    const getMe = jest
      .fn()
      .mockRejectedValue(new TelegramApiError('getMe', 404, 'Not Found', null));
    const { runtime } = makeRuntime(webhookEnv, { getMe });
    const { controller, router, rmq } = makeController(runtime);
    await controller.onTelegramUpdate(event as never, {} as never);
    expect(router.dispatch).not.toHaveBeenCalled();
    expect(rmq.ack).toHaveBeenCalledTimes(1);
  });
});
