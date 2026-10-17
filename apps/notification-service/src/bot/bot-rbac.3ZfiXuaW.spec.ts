import { Logger } from '@nestjs/common';
import { orderVisibleTo } from '../../../order-service/src/order-service.service';
import {
  ACTION_CONSUMED_TEXT,
  ACTION_FOREIGN_TEXT,
} from './bot-router.service';
import {
  COMMAND_GROUP_DENIED_TEXT,
  COMMAND_NOT_LINKED_TEXT,
  COMMAND_ROLE_DENIED_TEXT,
} from './handlers/command-gate.handler';
import type { BotActionHandler } from './handlers/bot-context';
import { callbackUpdate, makeRouter, textUpdate } from './testing/bot-kit-spec';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * 3ZfiXuaW / 5i3UZjiF / Pq2dFj8A — bot RBAC darvozasi: har update
 * `telegram_id → user → rol` (fail-closed); huquq ODAM bo'yicha, chat
 * bo'yicha emas; buyurtma doirasi SERVER tomonda (order-service).
 * Gateway HTTP doirasi (market_operator GET /orders, /orders/:id) —
 * apps/api-gateway/src/fix3-a2-order-scope.spec.ts.
 */
const actor = (role: string, id = '25', market_id: string | null = null) => ({
  user_id: id,
  role,
  status: 'active',
  market_id,
  region_id: null,
});
const replies = (ctx: ReturnType<typeof makeRouter>) =>
  (ctx.outbox.send.mock.calls as unknown as Array<[{ text: string }]>).map(
    ([message]) => message.text,
  );

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('3ZfiXuaW — aktor darvozasi (fail-closed)', () => {
  it('⭐ bog‘lanmagan chat `/status 1251145` — faqat "avval ulang", buyurtma o‘qilmaydi', async () => {
    const ctx = makeRouter({ actor: null });
    await ctx.router.dispatch('elchi', textUpdate('/status 1251145'));
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(replies(ctx)).toEqual([COMMAND_NOT_LINKED_TEXT]);
  });

  it('bog‘lanmagan chat — tushunarsiz matn va rol buyruqlariga hech qanday ma’lumot yo‘q', async () => {
    const ctx = makeRouter({ actor: null });
    await ctx.router.dispatch(
      'elchi',
      textUpdate('salom dunyo', { updateId: 1 }),
    );
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { updateId: 2 }));
    expect(replies(ctx)).toEqual([COMMAND_NOT_LINKED_TEXT]);
    // /start — yagona javob beradigan buyruq (ulash ko'rsatmasi).
    await ctx.router.dispatch('elchi', textUpdate('/start', { updateId: 3 }));
    expect(replies(ctx).at(-1)).toContain("Telegram'ni ulash");
  });

  it('⭐ rol reyestri: kuryer /balans → rad; market /ishim → rad; guruhda /ishim → rad', async () => {
    const courier = makeRouter({ actor: actor('courier') });
    await courier.router.dispatch('elchi', textUpdate('/balans'));
    expect(replies(courier)).toEqual([COMMAND_ROLE_DENIED_TEXT]);

    const market = makeRouter({ actor: actor('market', '37', '37') });
    await market.router.dispatch('elchi', textUpdate('/ishim'));
    expect(replies(market)).toEqual([COMMAND_ROLE_DENIED_TEXT]);

    const group = makeRouter({ actor: actor('courier') });
    await group.router.dispatch(
      'elchi',
      textUpdate('/ishim@elchi_bot', {
        chatId: -100555,
        chatType: 'supergroup',
        fromId: 25,
      }),
    );
    expect(replies(group)).toEqual([COMMAND_GROUP_DENIED_TEXT]);
    // Huquq odam bo'yicha: aktor guruhda ham `from.id` dan yechiladi.
    expect(group.actors.resolve).not.toHaveBeenCalledWith('-100555');
  });

  it('⭐ market operatori boshqa marketning buyurtmasi — "topilmadi"; so‘rovga requester qo‘shiladi (doira serverda)', async () => {
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 404,
      message: 'Order #202 topilmadi',
    });
    const ctx = makeRouter({ actor: actor('market_operator', '40', '37') });
    await ctx.router.dispatch('elchi', textUpdate('/status 202'));
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.find_by_id' },
      {
        id: '202',
        requester: { id: '40', roles: ['market_operator'], market_id: '37' },
      },
    );
    expect(replies(ctx)).toEqual(['❌ #202 buyurtma topilmadi.']);
  });
});

describe('3ZfiXuaW — callback: odam bo‘yicha va atomik', () => {
  const action = (overrides: Record<string, unknown> = {}) => ({
    action_id: '0123456789abcdef',
    chat_id: '-100555',
    action: 'order.sold',
    actor_user_id: '25',
    order_id: '1251145',
    payload: {},
    one_shot: true,
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    ...overrides,
  });

  it('⭐ guruhdagi begona a’zo bosgan tugma — rad (chat emas, from bo‘yicha)', async () => {
    const handle = jest.fn(() => Promise.resolve());
    const handler: BotActionHandler = { action: 'order.sold', handle };
    const ctx = makeRouter({
      actor: actor('courier', '26'),
      actionHandlers: [handler],
      lookup: jest.fn().mockResolvedValue({ status: 'ok', action: action() }),
    });
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate('a:0123456789abcdef', {
        chatId: -100555,
        fromId: 999,
        chatType: 'supergroup',
      }),
    );
    expect(ctx.actors.resolve).toHaveBeenCalledWith('999');
    expect(ctx.transport.answerCallbackQuery).toHaveBeenCalledWith(
      'cb1',
      ACTION_FOREIGN_TEXT,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(ctx.actions.consume).not.toHaveBeenCalled();
  });

  it('⭐ bitta callback ikki marta — ikkinchisi "allaqachon bajarilgan" (affected=0)', async () => {
    const handle = jest.fn(() => Promise.resolve());
    const consume = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const ctx = makeRouter({
      actor: actor('courier', '25'),
      actionHandlers: [{ action: 'order.sold', handle }],
      lookup: jest.fn().mockResolvedValue({ status: 'ok', action: action() }),
      consume,
    });
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate('a:0123456789abcdef', { fromId: 25 }),
    );
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate('a:0123456789abcdef', { fromId: 25 }),
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_CONSUMED_TEXT,
    );
  });

  it('eski `status:<id>` callback — buyurtma o‘qilmaydi (holat DB’da, `a:<id>` yo‘q)', async () => {
    const ctx = makeRouter({ actor: actor('market', '37', '37') });
    await ctx.router.dispatch('elchi', callbackUpdate('status:1251145'));
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(ctx.transport.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });
});

describe('5i3UZjiF / 3ZfiXuaW — order.find_by_id doirasi SERVER tomonda', () => {
  const order = { market_id: '37', courier_id: '25', holder_courier_id: '27' };

  it.each([
    ['superadmin', { id: '1', roles: ['superadmin'] }, true],
    ['admin', { id: '2', roles: ['ADMIN'] }, true],
    ['o‘z marketi', { id: '37', roles: ['market'] }, true],
    ['begona market', { id: '38', roles: ['market'] }, false],
    [
      'operator — o‘z marketi',
      { id: '40', roles: ['market_operator'], market_id: '37' },
      true,
    ],
    [
      'operator — begona market',
      { id: '40', roles: ['market_operator'], market_id: '38' },
      false,
    ],
    [
      'operator — marketsiz',
      { id: '40', roles: ['market_operator'], market_id: null },
      false,
    ],
    ['kuryer (courier_id)', { id: '25', roles: ['courier'] }, true],
    ['kuryer (holder_courier_id)', { id: '27', roles: ['courier'] }, true],
    ['begona kuryer', { id: '26', roles: ['courier'] }, false],
    ['registrator / boshqa rol', { id: '9', roles: ['registrator'] }, false],
    ['rolsiz', { id: '9', roles: [] }, false],
  ])('%s → %p', (_label, requester, visible) => {
    expect(orderVisibleTo(order, requester as never)).toBe(visible);
  });
});
