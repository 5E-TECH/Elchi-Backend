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
import { CourierActions, CourierHandler } from '../courier/courier.handler';
import { CourierService } from '../courier/courier.service';
import { ExtraCostActions } from '../extra-cost/extra-cost.actions';
import { PaymentAckActions } from '../finance/payment-ack.actions';
import { AiOrderService } from '../ai-order/ai-order.service';
import { AiOrderActions, AiOrderHandler } from '../ai-order/ai-order.handler';
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
    update: jest.fn(
      (
        where: { id: string } & Partial<OutboxRow>,
        patch: Partial<OutboxRow>,
      ) => {
        const row = rows.get(String(where.id));
        // Qo'shimcha shartlar (masalan `status: 'sending'`) ham hisobga olinadi.
        const matches =
          row &&
          Object.entries(where).every(
            ([key, value]) =>
              key === 'id' ||
              (row as unknown as Record<string, unknown>)[key] === value,
          );
        if (matches) Object.assign(row, patch);
        return Promise.resolve({ affected: matches ? 1 : 0 });
      },
    ),
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
  migrateChat: jest.Mock;
}

export function makeChannels(): FakeChannels {
  return {
    markInactive: jest.fn(() => Promise.resolve({ deactivated: 1 })),
    markActive: jest.fn(() => Promise.resolve()),
    migrateChat: jest.fn(() => Promise.resolve({ markets: 1, outbox: 1 })),
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
/** Xotiradagi `BotActionsService` (create → lookup → consume semantikasi). */
export function makeActionsStore(now: () => number = Date.now) {
  const rows = new Map<string, Record<string, any>>();
  let seq = 0;
  const store = {
    rows,
    create: jest.fn((input: Record<string, any>) => {
      seq += 1;
      const id = `act${String(seq).padStart(13, '0')}`;
      rows.set(id, {
        action_id: id,
        chat_id: input.chatId,
        action: input.action,
        actor_user_id: input.actorUserId ?? null,
        order_id: input.orderId ?? null,
        payload: input.payload ?? {},
        one_shot: input.oneShot ?? true,
        expires_at: new Date(now() + (input.ttlMs ?? 86_400_000)),
        consumed_at: null,
        message_id: null,
      });
      return Promise.resolve(`a:${id}`);
    }),
    lookup: jest.fn((data: string) => {
      const id = /^a:(.{16})$/.exec(String(data ?? ''))?.[1];
      const action = id ? rows.get(id) : undefined;
      if (!action) return Promise.resolve({ status: 'unknown' as const });
      if (action.consumed_at)
        return Promise.resolve({ status: 'consumed' as const, action });
      if (action.expires_at.getTime() <= now()) {
        return Promise.resolve({ status: 'expired' as const, action });
      }
      return Promise.resolve({ status: 'ok' as const, action });
    }),
    consume: jest.fn((id: string) => {
      const action = rows.get(id);
      if (
        !action ||
        action.consumed_at ||
        action.expires_at.getTime() <= now()
      ) {
        return Promise.resolve(false);
      }
      action.consumed_at = new Date(now());
      return Promise.resolve(true);
    }),
    /** (BOT-3d) handler xatosida bir martalik tugma qayta ochiladi. */
    release: jest.fn((id: string) => {
      const action = rows.get(id);
      if (action && action.expires_at.getTime() > now()) {
        action.consumed_at = null;
      }
      return Promise.resolve();
    }),
    attachMessage: jest.fn((data: string[], messageId: number) => {
      for (const item of data) {
        const action = rows.get(item.slice(2));
        if (action) action.message_id = String(messageId);
      }
      return Promise.resolve();
    }),
    /** Oxirgi yaratilgan amallar (berilgan turi bo'yicha) → callback_data. */
    dataOf: (action: string) =>
      [...rows.values()]
        .filter((row) => row.action === action)
        .map((row) => `a:${row.action_id}`),
  };
  return store;
}

/** Xotiradagi `BotSessionService` (load / update). */
export function makeSessionsStore() {
  const states = new Map<string, Record<string, unknown>>();
  return {
    states,
    load: jest.fn((chatId: string) =>
      Promise.resolve({
        chat_id: chatId,
        bot_slug: 'elchi',
        user_id: null,
        state: { ...(states.get(chatId) ?? {}) },
        version: 0,
        persisted: states.has(chatId),
      }),
    ),
    update: jest.fn(
      (
        chatId: string,
        _slug: string,
        mutate: (s: { state: Record<string, unknown> }) => {
          state: Record<string, unknown>;
        },
      ) => {
        const next = mutate({ state: { ...(states.get(chatId) ?? {}) } });
        states.set(chatId, next.state);
        return Promise.resolve({ chat_id: chatId, state: next.state });
      },
    ),
  };
}

/**
 * Router + haqiqiy handlerlar (start, group, darvoza, market, KURYER);
 * tashqi qaramliklar soxta. `inboundLimit` — xotiradagi hisoblagich (DB
 * semantikasi pg spec'da tekshirilgan). `gateway` — BotGatewayClient.request.
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
    gateway?: jest.Mock;
    downloadFile?: jest.Mock;
    inbox?: { dispatch: jest.Mock };
    /** (e7KhaeOO) AI buyurtma handleri — xotiradagi `telegram_ai_drafts` bilan. */
    aiOrder?: boolean;
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
  const sessions = makeSessionsStore();
  const store = makeActionsStore();
  const actions = {
    ...store,
    lookup: options.lookup ?? store.lookup,
    consume: options.consume ?? store.consume,
  };
  const actors = {
    resolve: jest.fn(() => Promise.resolve(options.actor ?? null)),
  };
  let messageSeq = 100;
  const outbox = {
    send: jest.fn(() => {
      messageSeq += 1;
      return Promise.resolve({
        id: String(messageSeq),
        status: 'sent',
        result: { message_id: messageSeq },
      });
    }),
  };
  const transport = {
    answerCallbackQuery: jest.fn(() => Promise.resolve()),
    describe: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    editMessage: jest.fn(() => Promise.resolve(true)),
    downloadFile:
      options.downloadFile ??
      jest.fn(() =>
        Promise.resolve({
          buffer: Buffer.from('img'),
          file_path: 'photos/1.jpg',
        }),
      ),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const membership = {
    handle: jest.fn(() => Promise.resolve()),
    migrate: jest.fn(() => Promise.resolve()),
  };
  const notifications = {
    connectGroupByCodeText: jest.fn(() =>
      Promise.resolve({ message: 'ulandi' }),
    ),
    warnGroupNewMembers: jest.fn(() => Promise.resolve({ markets: 1 })),
  };
  const env: Record<string, unknown> = {
    TELEGRAM_BOT_SLUG: options.slug ?? 'elchi',
    ELCHI_CABINET_URL: 'https://admin.elchi.test',
    ...options.env,
  };
  const config = { get: (key: string) => env[key] };
  const gateway = {
    request:
      options.gateway ??
      jest.fn(() => Promise.resolve({ status: 500, body: null })),
  };
  const cardRows = new Map<string, Record<string, any>>();
  const cards = {
    rows: cardRows,
    upsert: jest.fn((row: Record<string, any>) => {
      cardRows.set(`${row.order_id}:${row.chat_id}`, { ...row });
      return Promise.resolve();
    }),
    findOne: jest.fn(({ where }: { where: Record<string, string> }) =>
      Promise.resolve(
        cardRows.get(`${where.order_id}:${where.chat_id}`) ?? null,
      ),
    ),
    update: jest.fn(
      (where: Record<string, string>, patch: Record<string, unknown>) => {
        const row = cardRows.get(`${where.order_id}:${where.chat_id}`);
        if (row) Object.assign(row, patch);
        return Promise.resolve();
      },
    ),
  };
  const inbox = options.inbox ?? {
    dispatch: jest.fn(() => Promise.resolve({})),
  };
  const moduleRef = { get: () => inbox };
  const courierService = new CourierService(
    gateway as never,
    actions as never,
    outbox as never,
    transport as never,
    cards as never,
    config as never,
  );
  const courier = new CourierHandler(
    courierService,
    gateway as never,
    sessions as never,
    transport as never,
    actions as never,
    moduleRef as never,
  );
  const courierActions = new CourierActions(
    courierService,
    actions as never,
    sessions as never,
    courier,
  );
  const extraCost = new ExtraCostActions(
    gateway as never,
    actions as never,
    transport as never,
  );
  const paymentAck = new PaymentAckActions(
    gateway as never,
    transport as never,
  );
  const aiDrafts = makeAiDraftsStore();
  const aiService = options.aiOrder
    ? new AiOrderService(
        aiDrafts as never,
        gateway as never,
        actions as never,
        transport as never,
        config as never,
        outbox as never,
      )
    : null;
  const aiHandler = aiService ? new AiOrderHandler(aiService) : undefined;
  const aiActions = aiService ? new AiOrderActions(aiService) : null;
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
    courier,
    undefined,
    [
      ...courierActions.handlers,
      ...extraCost.handlers,
      ...paymentAck.handlers,
      ...(aiActions?.handlers ?? []),
      ...(options.actionHandlers ?? []),
    ],
    aiHandler,
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
    gateway: gateway.request,
    cards,
    inbox,
    aiDrafts,
    aiService,
  };
}

/**
 * Xotiradagi `telegram_ai_drafts` (e7KhaeOO): insert / update / findOne va
 * `preview → creating` da'vosi (`UPDATE … WHERE status = ANY($2)`).
 */
export function makeAiDraftsStore(now: () => number = Date.now) {
  const rows = new Map<string, Record<string, any>>();
  let tokenSeq = 0;
  return {
    rows,
    insert: jest.fn((row: Record<string, any>) => {
      // (BOT-3b) id update'dan deterministik — takror update unique xatosi.
      if (rows.has(row.id)) {
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      rows.set(row.id, {
        input: {},
        orders: null,
        results: null,
        message_id: null,
        ai_draft_id: null,
        error: null,
        expires_at: new Date(now() + 24 * 3_600_000),
        ...row,
      });
      return Promise.resolve();
    }),
    update: jest.fn(
      (
        where: { id: string; worker_token?: string },
        patch: Record<string, any>,
      ) => {
        const row = rows.get(where.id);
        // (BOT-3b) da'vo tokeni bilan yakuniy yozuv.
        if (
          !row ||
          (where.worker_token !== undefined &&
            row.worker_token !== where.worker_token)
        ) {
          return Promise.resolve({ affected: 0 });
        }
        Object.assign(row, patch);
        return Promise.resolve({ affected: 1 });
      },
    ),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.get(where.id) ? { ...rows.get(where.id) } : null),
    ),
    query: jest.fn((sql: string, params: unknown[]) => {
      // (BOT-3b) fondagi ishchi da'vosi: `worker_at IS NULL` bo'lsa oladi.
      if (/"worker_at" = now\(\)/.test(sql) && /"id" = \$1/.test(sql)) {
        const [claimId, status] = params as [string, string];
        const target = rows.get(claimId);
        if (
          !target ||
          target.status !== status ||
          target.worker_at ||
          new Date(target.expires_at).getTime() <= now()
        ) {
          return Promise.resolve([[], 0]);
        }
        target.worker_at = new Date(now());
        target.worker_token = `token-${++tokenSeq}`;
        return Promise.resolve([[{ ...target }], 1]);
      }
      const [id, from, to] = params as [string, string[], string];
      const row = rows.get(id);
      if (
        !/telegram_ai_drafts/.test(sql) ||
        !row ||
        !from.includes(row.status) ||
        new Date(row.expires_at).getTime() <= now()
      ) {
        return Promise.resolve([[], 0]);
      }
      row.status = to;
      row.worker_at = null;
      row.worker_token = null;
      return Promise.resolve([[{ ...row }], 1]);
    }),
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

export const courierActor = (userId = '25') => ({
  user_id: userId,
  role: 'courier',
  status: 'active',
  market_id: null,
  region_id: null,
});

export const gatewayOrder = (
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  status,
  total_price: '250000.00',
  market_id: '37',
  courier_id: '25',
  district: { name: 'Yunusobod' },
  customer: { name: 'TEST Mijoz', phone_number: '+998901234567' },
  market: { id: '37', expense_proof_conditions: [] },
  ...overrides,
});

/**
 * Soxta gateway (BotGatewayClient.request): buyurtmalar ro'yxati/karta,
 * kuryer amallari, `POST /files/upload`, analytics va my-cashbox. Doira —
 * faqat `courier_id` mos keladigan buyurtmalar (server qoidasi taqlidi).
 */
export function fakeOrdersGateway(
  orders: Array<Record<string, any>>,
  options: {
    courierId?: string;
    op?: (
      op: string,
      id: string,
      body: Record<string, any>,
    ) => { status: number; body: unknown } | undefined;
    stats?: Record<string, unknown>;
    cashbox?: Record<string, unknown>;
  } = {},
) {
  const courierId = options.courierId ?? '25';
  const byId = new Map(orders.map((order) => [String(order.id), order]));
  let uploads = 0;
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    options: unknown;
  }> = [];
  const request = jest.fn(
    (
      _tg: string,
      method: string,
      path: string,
      body?: unknown,
      opts?: unknown,
    ) => {
      calls.push({ method, path, body, options: opts });
      const [pathname, search = ''] = path.split('?');
      const query = new URLSearchParams(search);
      const own = (order: Record<string, any>) =>
        String(order.courier_id) === courierId ||
        String(order.holder_courier_id ?? '') === courierId;
      if (method === 'GET' && pathname === '/orders') {
        const statuses = query.getAll('status');
        const rows = [...byId.values()].filter(
          (order) =>
            own(order) && (!statuses.length || statuses.includes(order.status)),
        );
        const page = Number(query.get('page') ?? 1);
        const limit = Number(query.get('limit') ?? 10);
        const slice = rows.slice((page - 1) * limit, page * limit);
        return Promise.resolve({
          status: 200,
          body: {
            data: slice,
            total: rows.length,
            has_next: page * limit < rows.length,
          },
        });
      }
      const single = /^\/orders\/(\d+)$/.exec(pathname);
      if (method === 'GET' && single) {
        const order = byId.get(single[1]);
        return Promise.resolve(
          order && own(order)
            ? { status: 200, body: order }
            : {
                status: 403,
                body: { message: "Bu buyurtmani ko'rishga ruxsat yo'q" },
              },
        );
      }
      const op =
        /^\/orders\/(sell|cancel|rollback)\/(\d+)$/.exec(pathname) ??
        /^\/orders\/(\d+)\/(could-not-deliver)$/.exec(pathname);
      if (method === 'POST' && op) {
        const [kind, id] =
          op[2] === 'could-not-deliver' ? ['cnd', op[1]] : [op[1], op[2]];
        const custom = options.op?.(
          kind,
          id,
          (body ?? {}) as Record<string, any>,
        );
        if (custom) return Promise.resolve(custom);
        const order = byId.get(id);
        if (!order || !own(order)) {
          return Promise.resolve({
            status: 400,
            body: { message: 'Order is not assigned to this courier' },
          });
        }
        const allowed: Record<string, string[]> = {
          sell: ['waiting'],
          cancel: ['waiting'],
          cnd: ['on the road'],
          rollback: ['sold', 'cancelled'],
        };
        if (!allowed[kind].includes(order.status)) {
          return Promise.resolve({
            status: 400,
            body: { message: 'Order not found or not in waiting status' },
          });
        }
        const conditions: string[] =
          order.market?.expense_proof_conditions ?? [];
        const keys =
          ((body ?? {}) as { proofFileKeys?: string[] }).proofFileKeys ?? [];
        if (
          ((kind === 'sell' && conditions.includes('sell_any')) ||
            (kind === 'cancel' && conditions.includes('cancel_any'))) &&
          !keys.length
        ) {
          return Promise.resolve({
            status: 400,
            body: {
              message:
                'Bu amal uchun rasm yoki video isbot majburiy. Iltimos, isbot fayl(lar)ini biriktiring.',
            },
          });
        }
        if (keys.some((key) => !key.startsWith('proof-'))) {
          return Promise.resolve({
            status: 400,
            body: {
              message:
                'Isbot fayl topilmadi yoki yuklanmagan. Iltimos, isbotni qaytadan yuklang.',
            },
          });
        }
        order.status = {
          sell: 'sold',
          cancel: 'cancelled',
          cnd: 'waiting_customer',
          rollback: 'waiting',
        }[kind];
        return Promise.resolve({
          status: 200,
          body: { statusCode: 200, data: { id } },
        });
      }
      if (method === 'POST' && pathname === '/files/upload') {
        uploads += 1;
        return Promise.resolve({
          status: 201,
          body: { data: { key: `proof-${uploads}` } },
        });
      }
      if (method === 'GET' && pathname === '/analytics/dashboard') {
        return Promise.resolve({
          status: 200,
          body: { data: { myStat: options.stats ?? {} } },
        });
      }
      if (method === 'GET' && pathname === '/finance/cashbox/my-cashbox') {
        return Promise.resolve({
          status: 200,
          body: { data: { cashbox: options.cashbox ?? { balance: '0' } } },
        });
      }
      return Promise.resolve({ status: 404, body: null });
    },
  );
  return { request, calls, orders: byId };
}

/** Router orqali yuborilgan matnlar (outbox.send). */
export function sentTexts(ctx: { outbox: { send: jest.Mock } }): string[] {
  return (
    ctx.outbox.send.mock.calls as unknown as Array<[{ text: string }]>
  ).map(([message]) => message.text);
}

/** Oxirgi yuborilgan xabar tugmalari (matn → callback_data | url). */
export function lastButtons(ctx: {
  outbox: { send: jest.Mock };
}): Record<string, string> {
  const calls = ctx.outbox.send.mock.calls as unknown as Array<
    [
      {
        reply_markup?: {
          inline_keyboard: Array<
            Array<{ text: string; callback_data?: string; url?: string }>
          >;
        };
      },
    ]
  >;
  const markup = calls.at(-1)?.[0].reply_markup;
  return Object.fromEntries(
    (markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => [b.text, b.callback_data ?? b.url ?? '']),
  );
}
