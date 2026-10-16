import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import { NotificationServiceController } from '../notification-service.controller';
import { NotificationServiceService } from '../notification-service.service';
import { HealthController } from '../../../api-gateway/src/health.controller';
import { BotChannelService } from './bot-channel.service';
import { botTokenHealthy, BOT_METRICS } from './bot-metrics';
import {
  POLL_BACKOFF_MAX_MS,
  BotRuntimeService,
  pollBackoffMs,
} from './bot-runtime.service';
import {
  TELEGRAM_API_BASE,
  TelegramApiError,
  callTelegramApi,
  redactToken,
} from './bot-transport.service';
import { MembershipHandler } from './handlers/membership.handler';
import type { BotActionHandler } from './handlers/bot-context';
import {
  ENV_BOT_TOKEN,
  callbackUpdate,
  makeFetch,
  makeOutbox,
  makeOutboxRepo,
  makeRouter,
  makeTransport,
  telegramResponse,
} from './testing/bot-kit-spec';

/**
 * 9HIaV80X — xato holatlari, chiquvchi outbox va kuzatuv.
 */
describe('9HIaV80X — my_chat_member (bot chiqarildi / bloklandi)', () => {
  const makeChannels = (
    changedRows: Array<{ id: string; market_id: string }>,
  ) => {
    const query = jest.fn().mockResolvedValue(changedRows);
    const dispatch = jest.fn().mockResolvedValue({});
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const sessions = {
      update: jest.fn().mockResolvedValue({}),
      load: jest.fn().mockResolvedValue({ state: { blocked_at: 'x' } }),
    };
    const channels = new BotChannelService(
      { query } as never,
      sessions as never,
      activityLog as never,
      { get: () => ({ dispatch }) } as never,
    );
    return { channels, query, dispatch, activityLog, sessions };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['kicked', 'left'])(
    '⭐ guruhda %s → telegram_markets.is_active=false + admin bildirishnomasi + activity log',
    async (status) => {
      const deps = makeChannels([{ id: '10', market_id: '5' }]);
      const router = makeRouter();
      // Router'ning membership handleri — haqiqiy, kanal servisi soxta repo bilan.
      Object.assign(router.router, {
        membership: new MembershipHandler(deps.channels),
      });

      await router.router.dispatch('elchi', {
        update_id: 9,
        my_chat_member: {
          chat: { id: -100555, type: 'supergroup' },
          new_chat_member: { status },
          old_chat_member: { status: 'member' },
        },
      });

      expect(deps.query.mock.calls[0][0]).toMatch(/SET "is_active" = false/);
      expect(deps.query.mock.calls[0][1]).toEqual(['-100555']);
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'telegram.channel_inactive',
          roles: expect.arrayContaining(['admin']),
          data: expect.objectContaining({
            chat_id: '-100555',
            market_ids: ['5'],
          }),
        }),
      );
      expect(deps.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'notification.tg_channel_inactive',
          entity_id: '10',
        }),
      );
    },
  );

  it('shaxsiy chat bloklasa — sessiyada blocked_at; qayta `member` — blok olib tashlanadi', async () => {
    const deps = makeChannels([]);
    const handler = new MembershipHandler(deps.channels);
    await handler.handle('elchi', {
      chat: { id: 5550007, type: 'private' },
      new_chat_member: { status: 'kicked' },
    });
    expect(deps.query).not.toHaveBeenCalled();
    expect(deps.sessions.update).toHaveBeenCalledWith(
      '5550007',
      'elchi',
      expect.any(Function),
    );
    await handler.handle('elchi', {
      chat: { id: 5550007, type: 'private' },
      new_chat_member: { status: 'member' },
    });
    expect(deps.sessions.update).toHaveBeenCalledTimes(2);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe('9HIaV80X — sendMessage xato turlari va outbox', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ 403 "bot was blocked by the user" — qayta urinish YO‘Q, dead, kanal nofaol', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValue(
      telegramResponse(403, {
        ok: false,
        description: 'Forbidden: bot was blocked by the user',
      }),
    );
    const transport = makeTransport(fetchMock);
    await expect(
      transport.call('sendMessage', { chat_id: '1', text: 'x' }),
    ).rejects.toMatchObject({
      kind: 'blocked',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const { outbox, repo, channels } = makeOutbox(fetchMock);
    const result = await outbox.send({
      chatId: '5550007',
      text: 'x',
      source: 'test',
    });
    expect(result.status).toBe('dead');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.rows.get(result.id)!.status).toBe('dead');
    expect(channels.markInactive).toHaveBeenCalledWith(
      '5550007',
      'elchi',
      'blocked_on_send',
    );
    // Worker ham qayta olmaydi.
    expect(await outbox.processDue()).toBe(0);
  });

  it.each([
    [
      '429',
      telegramResponse(429, {
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: 2 },
      }),
    ],
    ['502', telegramResponse(502, { ok: false, description: 'Bad Gateway' })],
  ])(
    '⭐ %s → retry_count oshadi, N (max_attempts) dan keyin dead-letter',
    async (_label, response) => {
      const fetchMock = makeFetch();
      fetchMock.mockResolvedValue(response);
      const repo = makeOutboxRepo();
      const { outbox, channels } = makeOutbox(fetchMock, { repo });

      const first = await outbox.send({
        chatId: '-100555',
        text: 'x',
        source: 'test',
        maxAttempts: 3,
      });
      expect(first.status).toBe('queued');
      const row = repo.rows.get(first.id)!;
      expect(row.retry_count).toBe(1);

      row.next_attempt_at = new Date(0);
      await outbox.processDue();
      expect(row.status).toBe('pending');
      expect(row.retry_count).toBe(2);

      row.next_attempt_at = new Date(0);
      await outbox.processDue();
      expect(row.status).toBe('dead');
      expect(row.retry_count).toBe(3);
      expect(row.last_error).toMatch(/Too Many Requests|Bad Gateway/);
      expect(channels.markInactive).not.toHaveBeenCalled();
    },
  );

  it('⭐ (regressiya) yuborish to‘liq muvaffaqiyatsiz — chaqiruvchi 2xx EMAS (502) oladi', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValue(
      telegramResponse(403, {
        ok: false,
        description: 'Forbidden: bot was kicked from the group chat',
      }),
    );
    const service = new NotificationServiceService(
      { find: jest.fn() } as never,
      {} as never,
      { log: jest.fn() } as never,
      makeOutbox(fetchMock).outbox,
    );
    const res = await service.sendNotification({
      group_id: '-100999',
      message: 'x',
    } as never);
    expect(res?.statusCode).toBe(502);
    expect(res?.data).toEqual(
      expect.objectContaining({ total: 1, success: 0, failed: 1 }),
    );
  });
});

describe('9HIaV80X — polling backoff', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('pollBackoffMs: 3s → 6 → 12 → 24 → 48 → 60 (shift)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(pollBackoffMs)).toEqual([
      3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000,
    ]);
    expect(POLL_BACKOFF_MAX_MS).toBe(60_000);
  });

  it('⭐ getUpdates xatolarida 3s dan 60s gacha o‘sadi, 401 da BUTUNLAY to‘xtaydi', async () => {
    const getUpdates = jest.fn();
    for (let i = 0; i < 7; i += 1) {
      getUpdates.mockRejectedValueOnce(
        new TelegramApiError('getUpdates', 502, 'Bad Gateway', null),
      );
    }
    getUpdates.mockRejectedValueOnce(
      new TelegramApiError('getUpdates', 401, 'Unauthorized', null),
    );
    const runtime = new BotRuntimeService(
      {
        get: (key: string) =>
          ({ TELEGRAM_BOT_TOKEN: ENV_BOT_TOKEN, BOT_POLLING_LEADER: true })[
            key
          ],
      } as never,
      {
        getMe: jest.fn().mockResolvedValue({ id: 1, is_bot: true }),
        getWebhookInfo: jest.fn().mockResolvedValue({ url: '' }),
        getUpdates,
        describe: (e: unknown) => String(e),
      } as never,
      { dispatch: jest.fn() } as never,
      {
        getPollOffset: jest.fn().mockResolvedValue(0),
        setPollOffset: jest.fn(),
      } as never,
      {} as never,
    );
    const delays: number[] = [];
    let next: (() => void) | null = null;
    runtime.schedule = ((fn: () => void, ms: number) => {
      delays.push(ms);
      next = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as never;

    await runtime.onApplicationBootstrap();
    // Birinchi pollOnce bootstrap'da `void` bilan boshlangan — tugashini kutamiz.
    for (let i = 0; i < 20 && delays.length === 0; i += 1)
      await Promise.resolve();
    for (let i = 0; i < 7; i += 1) {
      const run = next as unknown as () => void;
      next = null;
      run();
      for (
        let j = 0;
        j < 20 && next === null && runtime.health().healthy !== false;
        j += 1
      ) {
        await Promise.resolve();
      }
    }

    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    expect(getUpdates).toHaveBeenCalledTimes(8);
    expect(runtime.health()).toEqual(
      expect.objectContaining({ healthy: false, mode: 'off' }),
    );
    // 401 dan keyin yangi sikl rejalashtirilmagan.
    expect(next).toBeNull();
  });
});

describe('9HIaV80X — readiness va metrikalar', () => {
  it('⭐ bot_token_healthy=0 → notification.health `degraded` → gateway readiness `down`', async () => {
    const runtime = {
      isDegraded: () => true,
      health: () => ({
        enabled: true,
        mode: 'off',
        healthy: false,
        username: null,
        reason: 'getMe 404',
      }),
    };
    const controller = Object.create(
      NotificationServiceController.prototype,
    ) as NotificationServiceController;
    Object.assign(controller, {
      botRuntime: runtime,
      rmqService: { ack: jest.fn() },
    });
    const reply = await controller.health({
      getChannelRef: () => ({ ack: jest.fn() }),
      getMessage: () => ({}),
    } as never);
    expect(reply).toEqual(
      expect.objectContaining({
        status: 'degraded',
        bot: expect.objectContaining({ healthy: false }),
      }),
    );

    const notificationClient = { send: jest.fn(() => of(reply)) };
    const okClient = {
      send: jest.fn(() => of({ status: 'Hammasi chotki ishlayapti!' })),
    };
    const gateway = new HealthController(
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      notificationClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
      okClient as never,
    );
    const res = { status: jest.fn() };
    const readiness = await gateway.readiness(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(
      readiness.services.find((s) => s.service === 'NOTIFICATION'),
    ).toEqual(
      expect.objectContaining({ status: 'down', error: 'reported degraded' }),
    );
    // Boshqa (matnli) holatlar — ok.
    expect(
      readiness.services.find((s) => s.service === 'IDENTITY')?.status,
    ).toBe('ok');
  });

  it('metrikalar: bot_updates_total, bot_send_total, bot_send_latency_ms, bot_linked_users, bot_token_healthy', async () => {
    const names = BOT_METRICS.map(
      (metric) => (metric as unknown as { name: string }).name,
    );
    expect(names.sort()).toEqual(
      [
        'bot_linked_users',
        'bot_send_latency_ms',
        'bot_send_total',
        'bot_token_healthy',
        'bot_updates_total',
      ].sort(),
    );
    botTokenHealthy.set({ bot: 'elchi' }, 0);
    const value = await botTokenHealthy.get();
    expect(value.values.find((v) => v.labels.bot === 'elchi')?.value).toBe(0);
  });

  it('alert qoidalari bot_token_healthy va bot_linked_users ga qurilgan', () => {
    const rules = readFileSync(
      join(
        __dirname,
        '../../../../libs/common/src/metrics/alerts/telegram-bot.rules.yml',
      ),
      'utf8',
    );
    expect(rules).toMatch(
      /alert: TelegramBotTokenUnhealthy[\s\S]*bot_token_healthy\) == 0/,
    );
    expect(rules).toMatch(
      /alert: TelegramBotNoLinkedUsers[\s\S]*bot_linked_users\) == 0/,
    );
  });
});

describe('9HIaV80X — loglarda bot tokeni YO‘Q', () => {
  afterEach(() => jest.restoreAllMocks());

  it('⭐ tarmoq xatosi matnidagi Bot API URL (bot<token>) redaktsiya qilinadi', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.reject(
        new Error(
          `request to ${TELEGRAM_API_BASE}/bot${ENV_BOT_TOKEN}/sendMessage failed, reason: ECONNRESET`,
        ),
      ),
    );
    const error = await callTelegramApi(
      ENV_BOT_TOKEN,
      'sendMessage',
      {},
      { fetchImpl: fetchImpl as never },
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(ENV_BOT_TOKEN);
    expect(String((error as Error).message)).not.toMatch(/bot\d+:/);
    expect(redactToken(`x bot123456:ABCDEFGHIJKLMNOP y`)).toBe(
      'x bot<redacted> y',
    );
  });

  it('⭐ outbox dead-letter / worker loglari tokensiz (log mock)', async () => {
    const lines: string[] = [];
    for (const level of ['warn', 'error', 'log'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          lines.push(String(message));
        });
    }
    const fetchMock = makeFetch();
    fetchMock.mockRejectedValue(
      new Error(
        `connect ETIMEDOUT ${TELEGRAM_API_BASE}/bot${ENV_BOT_TOKEN}/sendMessage`,
      ),
    );
    const { outbox } = makeOutbox(fetchMock);
    await outbox.send({
      chatId: '1',
      text: 'x',
      source: 'test',
      maxAttempts: 1,
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(ENV_BOT_TOKEN);
      expect(line).not.toMatch(/api\.telegram\.org\/bot\d/);
    }
  });
});

describe('9HIaV80X — activity_log: holat o‘zgartiruvchi callback', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ tugma bosilganda kim / qaysi chat / qaysi buyurtma / qachon yoziladi', async () => {
    const action = {
      action_id: '0123456789abcdef',
      chat_id: '111',
      action: 'order.sold',
      actor_user_id: '25',
      order_id: '1251145',
      payload: {},
      one_shot: true,
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    };
    const handle = jest.fn(() => Promise.resolve());
    const handler: BotActionHandler = { action: 'order.sold', handle };
    const ctx = makeRouter({
      actor: {
        user_id: '25',
        role: 'courier',
        status: 'active',
        market_id: null,
        region_id: null,
      },
      actionHandlers: [handler],
      lookup: jest.fn().mockResolvedValue({ status: 'ok', action }),
    });
    await ctx.router.dispatch('elchi', callbackUpdate('a:0123456789abcdef'));
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '1251145',
        action: 'notification.tg_callback',
        user_id: '25',
        metadata: expect.objectContaining({
          chat_id: '111',
          action: 'order.sold',
        }),
      }),
    );
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
