/**
 * Bot specs uchun umumiy to'plam (build'ga kirmaydi: `*spec.ts`, jest esa
 * faqat `.spec.ts` ni ishga tushiradi). HAQIQIY `BotTransportService` +
 * `BotOutboxService`, faqat tarmoq (fetch) va DB repozitoriyasi soxta.
 */
import type { BotActor } from '../bot-actor.service';
import { BotChannelService } from '../bot-channel.service';
import { BotOutboxService } from '../bot-outbox.service';
import { BotRouterService } from '../bot-router.service';
import { BotTransportService } from '../bot-transport.service';
import type { BotActionHandler } from '../handlers/bot-context';
import { CommandGateHandler } from '../handlers/command-gate.handler';
import { GroupHandler } from '../handlers/group.handler';
import { MarketHandler } from '../handlers/market.handler';
import { StartHandler } from '../handlers/start.handler';
import type { TelegramUpdate } from '../telegram.types';

export const ENV_BOT_TOKEN = '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa';

export type FetchMock = jest.Mock<
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
  [string, RequestInit]
>;

export function telegramResponse(
  status: number,
  body: Record<string, unknown>,
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

export const okResponse = (result: unknown = { message_id: 1 }) =>
  telegramResponse(200, { ok: true, result });

export function makeFetch(): FetchMock {
  return jest.fn(() => Promise.resolve(okResponse())) as unknown as FetchMock;
}

/** fetch chaqiruvlaridagi bot tokenlari (URL `bot<token>/<method>`). */
export function usedTokens(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map(([url]) =>
    String(url)
      .replace(/^https:\/\/api\.telegram\.org\/bot/, '')
      .replace(/\/[A-Za-z]+$/, ''),
  );
}

export function sentBodies(
  fetchMock: FetchMock,
): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(init.body as string) as Record<string, unknown>,
  );
}

export function makeTransport(
  fetchMock: FetchMock,
  env: Record<string, unknown> = { TELEGRAM_BOT_TOKEN: ENV_BOT_TOKEN },
) {
  const transport = new BotTransportService({
    get: (key: string) => env[key],
  } as never);
  transport.fetchImpl = fetchMock as never;
  transport.sleep = jest.fn(() => Promise.resolve());
  return transport;
}

export interface OutboxRow {
  id: string;
  chat_id: string;
  payload: Record<string, unknown>;
  status: string;
  retry_count: number;
  max_attempts: number;
  last_error?: string | null;
  next_attempt_at?: Date;
  source?: string | null;
}

/** `telegram_outbox` repozitoriyasi — xotirada. */
export function makeOutboxRepo() {
  const rows = new Map<string, OutboxRow>();
  let seq = 0;
  return {
    rows,
    insert: jest.fn((value: Omit<OutboxRow, 'id'>) => {
      seq += 1;
      const id = String(seq);
      rows.set(id, { ...value, id } as OutboxRow);
      return Promise.resolve({ identifiers: [{ id }] });
    }),
    update: jest.fn((where: { id: string }, patch: Partial<OutboxRow>) => {
      const row = rows.get(String(where.id));
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    /** Worker da'vosi: muddati kelgan `pending` qatorlar. */
    query: jest.fn(() => {
      const due = [...rows.values()].filter(
        (row) =>
          row.status === 'pending' &&
          (!row.next_attempt_at || row.next_attempt_at.getTime() <= Date.now()),
      );
      for (const row of due) row.status = 'sending';
      return Promise.resolve(due.map((row) => ({ ...row })));
    }),
  };
}

export interface FakeChannels {
  markInactive: jest.Mock;
  markActive: jest.Mock;
}

export function makeChannels(): FakeChannels {
  return {
    markInactive: jest.fn(() => Promise.resolve({ deactivated: 1 })),
    markActive: jest.fn(() => Promise.resolve()),
  };
}

export function makeOutbox(
  fetchMock: FetchMock,
  options: {
    env?: Record<string, unknown>;
    repo?: ReturnType<typeof makeOutboxRepo>;
    channels?: FakeChannels;
  } = {},
) {
  const env = options.env ?? { TELEGRAM_BOT_TOKEN: ENV_BOT_TOKEN };
  const transport = makeTransport(fetchMock, env);
  const repo = options.repo ?? makeOutboxRepo();
  const channels = options.channels ?? makeChannels();
  const outbox = new BotOutboxService(
    repo as never,
    transport,
    channels as unknown as BotChannelService,
    { get: (key: string) => env[key] } as never,
  );
  return { outbox, transport, repo, channels };
}

/** Handler testlari uchun kontekst: `reply` — yozib boriladi. */
export function makeCtx(
  options: {
    text?: string;
    chatId?: string;
    chatType?: string;
    fromId?: string | null;
    actor?: BotActor | null;
    update?: TelegramUpdate;
  } = {},
) {
  const chatId = options.chatId ?? '111';
  const chatType = options.chatType ?? 'private';
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const reply = jest.fn((text: string, extra?: unknown) => {
    replies.push({ text, extra });
    return Promise.resolve({
      id: String(replies.length),
      status: 'sent' as const,
    });
  });
  const actor = jest.fn(() => Promise.resolve(options.actor ?? null));
  const ctx = {
    slug: 'elchi',
    update: options.update ?? {
      update_id: 1,
      message: {
        chat: { id: chatId, type: chatType },
        from: { id: options.fromId ?? chatId },
        text: options.text ?? '',
      },
    },
    chatId,
    chatType,
    isPrivate: chatType === 'private',
    fromId: options.fromId === undefined ? chatId : options.fromId,
    text: (options.text ?? '').trim(),
    actor,
    session: jest.fn(() =>
      Promise.resolve({
        chat_id: chatId,
        bot_slug: 'elchi',
        user_id: null,
        state: {},
        version: 0,
        persisted: false,
      }),
    ),
    reply,
  };
  return { ctx, replies, reply, actor };
}

export const marketActor = (marketId = '5') => ({
  user_id: marketId,
  role: 'market',
  status: 'active',
  market_id: marketId,
  region_id: null,
});

/**
 * Router + haqiqiy handlerlar; tashqi qaramliklar soxta. `inboundLimit` —
 * xotiradagi hisoblagich (DB semantikasi pg spec'da tekshirilgan).
 */
export function makeRouter(
  options: {
    actor?: BotActor | null;
    inboundLimit?: number;
    slug?: string;
    actionHandlers?: BotActionHandler[];
    lookup?: jest.Mock;
    consume?: jest.Mock;
    dm?: { bindFromStart: jest.Mock; unbind: jest.Mock };
    orders?: unknown;
    env?: Record<string, unknown>;
  } = {},
) {
  const counts = new Map<string, number>();
  const limiter = {
    inbound: jest.fn((chatId: string) => {
      const hits = (counts.get(chatId) ?? 0) + 1;
      counts.set(chatId, hits);
      return Promise.resolve({
        allowed: hits <= (options.inboundLimit ?? 20),
        blocked: false,
        hits,
      });
    }),
    linkAttempt: jest.fn(() =>
      Promise.resolve({ allowed: true, blocked: false, hits: 1 }),
    ),
    firstSeen: jest.fn(() => Promise.resolve(true)),
  };
  const sessions = {
    load: jest.fn((chatId: string) =>
      Promise.resolve({
        chat_id: chatId,
        bot_slug: 'elchi',
        user_id: null,
        state: {},
        version: 0,
        persisted: false,
      }),
    ),
  };
  const actions = {
    lookup:
      options.lookup ?? jest.fn(() => Promise.resolve({ status: 'unknown' })),
    consume: options.consume ?? jest.fn(() => Promise.resolve(true)),
  };
  const actors = {
    resolve: jest.fn(() => Promise.resolve(options.actor ?? null)),
  };
  const outbox = {
    send: jest.fn(() => Promise.resolve({ id: '1', status: 'sent' })),
  };
  const transport = {
    answerCallbackQuery: jest.fn(() => Promise.resolve()),
    describe: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const membership = { handle: jest.fn(() => Promise.resolve()) };
  const notifications = {
    connectGroupByCodeText: jest.fn(() =>
      Promise.resolve({ message: 'ulandi' }),
    ),
  };
  const env: Record<string, unknown> = {
    TELEGRAM_BOT_SLUG: options.slug ?? 'elchi',
    ...options.env,
  };
  const config = { get: (key: string) => env[key] };
  const start = new StartHandler(
    limiter as never,
    activityLog as never,
    config as never,
    options.dm as never,
  );
  const group = new GroupHandler(notifications as never, limiter as never);
  const market = new MarketHandler((options.orders ?? {}) as never);
  const gate = new CommandGateHandler();
  const router = new BotRouterService(
    config as never,
    limiter as never,
    sessions as never,
    actions as never,
    actors as never,
    outbox as never,
    transport as never,
    activityLog as never,
    membership as never,
    start,
    group,
    market,
    gate,
    undefined,
    options.actionHandlers,
  );
  return {
    router,
    limiter,
    sessions,
    actions,
    actors,
    outbox,
    transport,
    activityLog,
    membership,
    notifications,
  };
}

export const textUpdate = (
  text: string,
  options: {
    chatId?: number;
    chatType?: string;
    fromId?: number;
    updateId?: number;
  } = {},
) => ({
  update_id: options.updateId ?? 1,
  message: {
    message_id: 1,
    chat: { id: options.chatId ?? 111, type: options.chatType ?? 'private' },
    from: { id: options.fromId ?? options.chatId ?? 111 },
    text,
  },
});

export const callbackUpdate = (
  data: string,
  options: { chatId?: number; fromId?: number; chatType?: string } = {},
) => ({
  update_id: 2,
  callback_query: {
    id: 'cb1',
    data,
    from: { id: options.fromId ?? options.chatId ?? 111 },
    message: {
      message_id: 9,
      chat: { id: options.chatId ?? 111, type: options.chatType ?? 'private' },
    },
  },
});

/**
 * Soxta `TelegramLinkService`: `codes` — kod → egasi. Birinchi `claim` ok,
 * keyingisi `used` (bir martalik). Ro'yxatda yo'q kod — `invalid`.
 */
export function makeLinks(
  codes: Record<
    string,
    {
      owner_id: string;
      purpose?: 'user' | 'market_group';
      group_type?: string | null;
      created_by?: string | null;
      status?: 'expired';
    }
  > = {},
) {
  const used = new Set<string>();
  const issued: Array<Record<string, unknown>> = [];
  return {
    issued,
    issue: jest.fn((input: Record<string, unknown>) => {
      issued.push(input);
      return Promise.resolve({
        token: `T${String(issued.length).padStart(42, '0')}`,
        expires_at: new Date(Date.now() + 600_000),
      });
    }),
    claim: jest.fn((token: string, scope: 'private' | 'group') => {
      const entry = codes[token];
      if (!entry) return Promise.resolve({ status: 'invalid' as const });
      if (entry.status === 'expired') {
        return Promise.resolve({ status: 'expired' as const });
      }
      if (used.has(token)) return Promise.resolve({ status: 'used' as const });
      const purpose = entry.purpose ?? 'market_group';
      if ((purpose === 'market_group') !== (scope === 'group')) {
        return Promise.resolve({ status: 'wrong_scope' as const });
      }
      used.add(token);
      return Promise.resolve({
        status: 'ok' as const,
        token: {
          token_hash: 'h',
          purpose,
          owner_type: purpose === 'user' ? 'courier' : 'market',
          owner_id: entry.owner_id,
          chat_scope: scope,
          group_type: entry.group_type ?? null,
          created_by: entry.created_by ?? null,
        },
      });
    }),
  };
}
