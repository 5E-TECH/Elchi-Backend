import { Logger } from '@nestjs/common';
import { BotPasswordChangeRequiredError } from '../bot-gateway.client';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_CONFIRM_UNKNOWN_LINE,
  type AiPreviewOrder,
  confirmFingerprint,
  markConfirmAttempted,
  toConfirmOrder,
} from './ai-preview';

/**
 * Natijasi noma'lum ai-confirm (timeout / tarmoq / 5xx / tushunarsiz javob /
 * qotgan `creating`) dan keyin botda tuzatish YOPIQ: server kaliti
 * `ai:<market>:<draft>:<index>` muddatsiz va yukni solishtirmaydi — keyingi
 * «✅» birinchi urinish natijasini (`idempotent_replay`) qaytaradi, tuzatish
 * jimgina yo'qolardi. Barcha ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Test Mijoz 90 000 00 01 Test tuman, Namuna atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555d1';

const preview = (extra: Partial<AiPreviewOrder> = {}): AiPreviewOrder => ({
  index: 0,
  ready: false,
  issues: ['item_unresolved'],
  customer_name: 'Test Mijoz',
  phone_number: '+998900000001',
  extra_number: null,
  region_id: '3',
  region_name: 'Test viloyat',
  district_id: '12',
  district_name: 'Test tuman',
  address: null,
  items: [
    {
      name: 'Namuna atir',
      quantity: 2,
      product_id: null,
      resolved_name: null,
      unresolved: true,
      candidates: [{ id: '500', name: 'Namuna atir 1' }],
    },
  ],
  total_price: 150000,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: null,
  checks: [],
  ...extra,
});

type GatewayCall = { tg: string; method: string; path: string; body: unknown };
type Reply = { status: number; body: unknown } | Error;

/** Sukut: yaratildi; ikkinchi urinish — server takroriy javobi. */
const created = (replay = false): Reply => ({
  status: 200,
  body: {
    data: {
      results: [
        { index: 0, ok: true, order_id: '81', idempotent_replay: replay },
      ],
    },
  },
});

function setup(orders: AiPreviewOrder[], confirmReplies: Reply[]) {
  const calls: GatewayCall[] = [];
  const gateway = jest.fn(
    (tg: string, method: string, path: string, body: unknown) => {
      calls.push({ tg, method, path, body });
      if (path === '/orders/ai-parse') {
        return Promise.resolve({
          status: 200,
          body: { data: { ok: true, draft_id: DRAFT_ID, orders } },
        });
      }
      if (path === '/orders/ai-confirm') {
        const reply = confirmReplies.shift() ?? created(true);
        return reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve(reply);
      }
      return Promise.resolve({ status: 404, body: null });
    },
  );
  const ctx = makeRouter({
    actor: {
      user_id: '40',
      role: 'market',
      status: 'active',
      market_id: '40',
      region_id: null,
    },
    gateway,
    aiOrder: true,
  });
  return { ctx, calls };
}

type Ctx = ReturnType<typeof makeRouter>;
type Markup = {
  inline_keyboard: Array<
    Array<{ text: string; callback_data?: string; url?: string }>
  >;
};

/** Oxirgi tugmali xabar (yangi yoki tahrir) — matn → callback_data | url. */
const buttons = (ctx: Ctx): Record<string, string> => {
  const sends = ctx.outbox.send.mock.calls.map((call, i) => ({
    order: ctx.outbox.send.mock.invocationCallOrder[i],
    markup: (call[0] as { reply_markup?: Markup }).reply_markup,
  }));
  const edits = ctx.transport.editMessage.mock.calls.map((call, i) => ({
    order: ctx.transport.editMessage.mock.invocationCallOrder[i],
    markup: (call[2] as { reply_markup?: Markup } | undefined)?.reply_markup,
  }));
  const last = [...sends, ...edits]
    .sort((a, b) => a.order - b.order)
    .filter((e) => (e.markup?.inline_keyboard ?? []).flat().length)
    .at(-1);
  return Object.fromEntries(
    (last?.markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => [b.text, b.callback_data ?? b.url ?? '']),
  );
};
const settle = async <T>(ctx: Ctx, p: Promise<T>) => {
  const result = await p;
  await ctx.aiService?.idle();
  return result;
};
let updateSeq = 10;
const send = (ctx: Ctx, text: string) =>
  settle(
    ctx,
    ctx.router.dispatch(
      'elchi',
      textUpdate(text, { chatId: 40, updateId: (updateSeq += 1) }),
    ),
  );
const press = (ctx: Ctx, data: string) =>
  settle(
    ctx,
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: 40, fromId: 40 }),
    ),
  );
const row = (ctx: Ctx) => [...ctx.aiDrafts.rows.values()][0];
const lastShown = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';
const confirms = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-confirm');
const sentItems = (call: GatewayCall) =>
  (call.body as { orders: Array<{ items: unknown[] }> }).orders[0].items;

const LOCKED_KEYS = ['✅ Yaratish', '❌ Bekor', '🌐 Kabinetda yaratish'];

describe('noma‘lum natijali ai-confirm — tuzatish yopiladi (regressiya)', () => {
  it('⭐ timeout → preview: faqat ✅/❌/🌐, eski «❓» va nomzod tugmasi mahsulotni o‘zgartirmaydi; qayta ✅ — o‘sha yuk', async () => {
    const { ctx, calls } = setup(
      [preview()],
      [new Error('timeout'), created(true)],
    );
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    await press(ctx, card['❓ Namuna atir — tanlash']);
    const picker = buttons(ctx);
    await press(ctx, picker['↩️ Orqaga']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);

    expect(row(ctx).status).toBe('preview');
    const order = row(ctx).orders[0] as AiPreviewOrder;
    expect(typeof order.confirm_attempted_at).toBe('number');
    expect(order.confirm_fp).toBe(confirmFingerprint(preview()));
    expect(lastShown(ctx)).toContain(AI_CONFIRM_UNKNOWN_LINE);
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);

    // Eski kartadagi tugmalar — tuzatish yo'q, karta qayta.
    await press(ctx, card['❓ Namuna atir — tanlash']);
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
    await press(ctx, picker['✅ Namuna atir 1']);
    expect(row(ctx).orders[0].items[0].product_id).toBeNull();
    await press(ctx, picker['🔎 Qidirish']);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    await press(ctx, picker['📝 Nomi bilan qoldirish']);
    expect(row(ctx).orders[0].items[0].keep_name).toBeUndefined();

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(2);
    expect(sentItems(confirms(calls)[1])).toEqual(
      sentItems(confirms(calls)[0]),
    );
    expect(lastShown(ctx)).toContain('avval yaratilgan');
    expect(lastShown(ctx)).not.toContain("Tuzatishlar qo'llanmadi");
    // Belgi ai-confirm'ga yuborilmaydi.
    expect(JSON.stringify(confirms(calls)[1].body)).not.toContain('confirm_');
  });

  it('kutilayotgan «🔎» so‘rovi noma‘lum urinishdan keyin qidiruv qilmaydi', async () => {
    const { ctx, calls } = setup([preview()], [new Error('timeout')]);
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    await press(ctx, card['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    // Qidiruv kutilayotganda boshqa (eski) kartadan ✅ bosildi.
    await press(ctx, card['✅ Yaratish']);
    ctx.sessions.states.set('40', {
      ai_input: {
        draft_id: row(ctx).id,
        kind: 'search',
        o: 0,
        i: 0,
        at: Date.now(),
      },
    });
    await send(ctx, 'krem');
    expect(calls.filter((c) => c.path.startsWith('/product/'))).toEqual([]);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
  });

  it.each([
    ['5xx', { status: 502, body: { message: 'Bad gateway' } }],
    ['200, natijalar massiv emas', { status: 200, body: { data: {} } }],
  ])('%s — belgi qo‘yiladi', async (_name, reply) => {
    const { ctx } = setup([preview()], [reply]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
  });

  it.each([
    ['4xx xabar bilan', { status: 400, body: { message: 'Narx noto‘g‘ri' } }],
    [
      '409 CHECKS_NOT_ACKNOWLEDGED',
      {
        status: 409,
        body: {
          code: 'CHECKS_NOT_ACKNOWLEDGED',
          orders: [{ index: 0, missing: ['price_check'] }],
        },
      },
    ],
    [
      '503 AI_CHECKS_UNAVAILABLE',
      { status: 503, body: { code: 'AI_CHECKS_UNAVAILABLE' } },
    ],
    ['parol almashtirish', new BotPasswordChangeRequiredError()],
  ])('%s — server aniq yaratmadi, belgi YO‘Q', async (_name, reply) => {
    const { ctx } = setup([preview()], [reply]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).orders[0].confirm_attempted_at).toBeUndefined();
    expect(shownTexts(ctx).join('\n')).not.toContain(AI_CONFIRM_UNKNOWN_LINE);
  });

  it('qotgan `creating` (recoverStale) — belgi qo‘yiladi', async () => {
    const { ctx } = setup([preview()], []);
    await send(ctx, ORDER_TEXT);
    const draft = row(ctx);
    draft.status = 'creating';
    const query = ctx.aiDrafts.query.getMockImplementation()!;
    ctx.aiDrafts.query.mockImplementation((sql: string, params: unknown[]) => {
      if (/WITH stale/.test(sql)) {
        draft.status = 'preview';
        return Promise.resolve([[{ ...draft, old_status: 'creating' }], 1]);
      }
      return query(sql, params);
    });
    await ctx.aiService!.tick();
    expect(typeof draft.orders[0].confirm_attempted_at).toBe('number');
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
  });

  it('takroriy javob, lekin qoralama urinishdan keyin o‘zgargan — «tuzatishlar qo‘llanmadi»', async () => {
    // Masalan deploy'dan oldingi urinish: belgi bor, ma'lumot keyin o'zgargan.
    const attempted = markConfirmAttempted([preview()], [preview()], 1)[0];
    const changed: AiPreviewOrder = {
      ...attempted,
      issues: [],
      items: [{ ...attempted.items![0], product_id: '500', unresolved: false }],
    };
    expect(toConfirmOrder(changed, null).items).toEqual([
      { product_id: '500', quantity: 2 },
    ]);
    const { ctx } = setup([changed], [created(true)]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastShown(ctx)).toContain('avval yaratilgan');
    expect(lastShown(ctx)).toContain("⚠️ 1) Tuzatishlar qo'llanmadi");
  });
});
