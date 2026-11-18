import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_HINT_TEXT } from './ai-order.handler';
import { AI_EXPIRED_TEXT, AI_INPUT_TTL_MS } from './ai-order.service';
import { toConfirmOrder, type AiPreviewOrder } from './ai-preview';
import {
  AI_SEARCH_PROMPT_TEXT,
  applyKeepName,
  applyProductPick,
} from './ai-product-pick';

/**
 * Bot AI preview: katalogda topilmagan mahsulotni tanlash — AI nomzodlari
 * (≤5, BeePost `MAX_CANDIDATE_BUTTONS`), «🔎 Qidirish» (my-products) yoki
 * «📝 Nomi bilan qoldirish». Tugma payload'ida faqat indekslar. Barcha
 * ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT = 'Test Mijoz 90 000 00 01 Asaka, Namuna atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555b1';

const candidates = (n: number) =>
  Array.from({ length: n }, (_, k) => ({
    id: String(500 + k),
    name: `Namuna atir ${k + 1}`,
  }));

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
      candidates: candidates(2),
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

function setup(
  orders: AiPreviewOrder[],
  search: (path: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      data: [
        { id: '901', name: 'Qidirilgan krem' },
        { id: '902', name: 'Qidirilgan krem 2' },
      ],
      total: 2,
    },
  }),
) {
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
        return Promise.resolve({
          status: 200,
          body: { data: { results: [{ index: 0, ok: true, order_id: '81' }] } },
        });
      }
      if (path.startsWith('/product/my-products')) {
        return Promise.resolve(search(path));
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
  inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
};

/** Oxirgi tugmali xabar (yangi yoki tahrir) — matn → callback_data. */
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
      .filter((b) => b.callback_data)
      .map((b) => [b.text, b.callback_data!]),
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
const draftRow = (ctx: Ctx) => [...ctx.aiDrafts.rows.values()][0];
const lastShown = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';
const confirmBody = (calls: GatewayCall[]) =>
  calls.find((c) => c.path === '/orders/ai-confirm')?.body as {
    orders: Array<{ items: unknown[] }>;
  };

describe('ai-product-pick — sof funksiyalar', () => {
  it('nomzod tanlansa product_id qo‘yiladi, item_unresolved olinadi, confirm product_id yuboradi', () => {
    const orders = applyProductPick([preview()], 0, 0, 'c', 1)!;
    expect(orders[0].items![0]).toEqual(
      expect.objectContaining({
        product_id: '501',
        resolved_name: 'Namuna atir 2',
        unresolved: false,
      }),
    );
    expect(orders[0].issues).toEqual([]);
    expect(toConfirmOrder(orders[0], null).items).toEqual([
      { product_id: '501', quantity: 2 },
    ]);
  });

  it('ro‘yxatda yo‘q indeks / noto‘g‘ri item — o‘zgarish yo‘q (null)', () => {
    expect(applyProductPick([preview()], 0, 0, 'c', 7)).toBeNull();
    expect(applyProductPick([preview()], 0, 3, 'c', 0)).toBeNull();
    expect(applyProductPick([preview()], 0, 0, 's', 0)).toBeNull();
  });

  it('nomi bilan qoldirish — allow_unlisted_product (avvalgi xatti-harakat)', () => {
    const orders = applyKeepName([preview()], 0, 0)!;
    expect(orders[0].items![0].keep_name).toBe(true);
    expect(toConfirmOrder(orders[0], null).items).toEqual([
      {
        product_name: 'Namuna atir',
        allow_unlisted_product: true,
        quantity: 2,
      },
    ]);
  });
});

describe('bot — katalogda topilmagan mahsulotni tanlash', () => {
  it('⭐ «❓ … — tanlash» → nomzodlar → tanlash: product_id qoralamada, karta qayta, confirm product_id bilan', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    expect(Object.keys(card)).toEqual([
      '✅ Yaratish',
      '❓ Namuna atir — tanlash',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    await press(ctx, card['❓ Namuna atir — tanlash']);
    expect(lastShown(ctx)).toContain('katalogda aniq topilmadi');
    const picker = buttons(ctx);
    expect(Object.keys(picker)).toEqual([
      '✅ Namuna atir 1',
      '✅ Namuna atir 2',
      '🔎 Qidirish',
      '📝 Nomi bilan qoldirish',
      '↩️ Orqaga',
    ]);
    // callback_data — qisqa `a:<id>`; payload'da nom emas, faqat indekslar.
    for (const data of Object.values(picker)) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
    const pickRow = [...ctx.actions.rows.values()].find(
      (r) => `a:${r.action_id}` === picker['✅ Namuna atir 2'],
    )!;
    expect(pickRow.payload).toEqual({
      o: 0,
      i: 0,
      s: 'c',
      k: 1,
      draft_id: draftRow(ctx).id,
    });

    await press(ctx, picker['✅ Namuna atir 2']);
    expect(draftRow(ctx).orders[0].items[0]).toEqual(
      expect.objectContaining({ product_id: '501', unresolved: false }),
    );
    expect(lastShown(ctx)).toContain('Namuna atir 2 ×2');
    expect(lastShown(ctx)).not.toContain('katalogda topilmadi');
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmBody(calls).orders[0].items).toEqual([
      { product_id: '501', quantity: 2 },
    ]);
  });

  it('nomzodlar ko‘pi bilan 5 ta tugma', async () => {
    const { ctx } = setup([
      preview({
        items: [
          {
            name: 'Namuna atir',
            quantity: 1,
            product_id: null,
            unresolved: true,
            candidates: candidates(7),
          },
        ],
      }),
    ]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    expect(
      Object.keys(buttons(ctx)).filter((t) => t.startsWith('✅ Namuna')),
    ).toHaveLength(5);
  });

  it('⭐ «🔎 Qidirish» → matn → my-products (operator JWT) → natijadan tanlash', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    expect(lastShown(ctx)).toBe(AI_SEARCH_PROMPT_TEXT);
    expect(ctx.sessions.states.get('40')?.ai_input).toEqual(
      expect.objectContaining({ draft_id: draftRow(ctx).id, o: 0, i: 0 }),
    );

    await send(ctx, 'qidirilgan krem');
    const search = calls.filter((c) => c.path.startsWith('/product/'));
    expect(search).toEqual([
      expect.objectContaining({
        tg: '40',
        method: 'GET',
        path: '/product/my-products?search=qidirilgan%20krem&page=1&limit=5',
      }),
    ]);
    // AI chaqirilmadi (qidiruv so'rovi yangi buyurtma emas).
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(1);
    expect(lastShown(ctx)).toContain('«qidirilgan krem» bo‘yicha topildi');
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    const results = buttons(ctx);
    expect(Object.keys(results)).toEqual([
      '✅ Qidirilgan krem',
      '✅ Qidirilgan krem 2',
      '🔎 Qayta qidirish',
      '📝 Nomi bilan qoldirish',
      '↩️ Orqaga',
    ]);

    await press(ctx, results['✅ Qidirilgan krem 2']);
    expect(draftRow(ctx).orders[0].items[0]).toEqual(
      expect.objectContaining({
        product_id: '902',
        resolved_name: 'Qidirilgan krem 2',
      }),
    );
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmBody(calls).orders[0].items).toEqual([
      { product_id: '902', quantity: 2 },
    ]);
  });

  it('qidiruv natijasiz — kutish davom etadi; «📝 Nomi bilan qoldirish» — nom bilan yaratiladi', async () => {
    const { ctx, calls } = setup([preview()], () => ({
      status: 200,
      body: { data: [], total: 0 },
    }));
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    await send(ctx, 'yoq narsa');
    expect(lastShown(ctx)).toContain('mahsulot topilmadi');
    expect(ctx.sessions.states.get('40')?.ai_input).toBeDefined();

    await press(ctx, buttons(ctx)['📝 Nomi bilan qoldirish']);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    expect(draftRow(ctx).orders[0].items[0].keep_name).toBe(true);
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmBody(calls).orders[0].items).toEqual([
      {
        product_name: 'Namuna atir',
        allow_unlisted_product: true,
        quantity: 2,
      },
    ]);
  });

  it('«↩️ Orqaga» — kutish bekor, karta qaytadi; keyingi matn qidiruv emas', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    await press(ctx, buttons(ctx)['↩️ Orqaga']);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    expect(lastShown(ctx)).toContain('AI 1 ta buyurtma topdi');
    await send(ctx, 'qidirilgan krem');
    expect(calls.filter((c) => c.path.startsWith('/product/'))).toEqual([]);
    expect(lastShown(ctx)).toBe(AI_HINT_TEXT);
  });

  it('kutish paytida buyurtmaga o‘xshash matn (7+ raqam) — qidiruv emas, yangi AI tahlil', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    await send(ctx, 'Boshqa Mijoz 90 000 00 02 Asaka, krem 1 ta, 90000');
    expect(calls.filter((c) => c.path.startsWith('/product/'))).toEqual([]);
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(2);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
  });

  it('eskirgan qoralama: tanlash tugmasi va kutilgan matn — «eskirgan», hech narsa o‘zgarmaydi', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    const picker = buttons(ctx);
    await press(ctx, picker['🔎 Qidirish']);
    draftRow(ctx).expires_at = new Date(Date.now() - 1000);

    await send(ctx, 'qidirilgan krem');
    expect(calls.filter((c) => c.path.startsWith('/product/'))).toEqual([]);
    expect(shownTexts(ctx)).toContain(AI_EXPIRED_TEXT);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();

    await press(ctx, picker['✅ Namuna atir 1']);
    expect(draftRow(ctx).orders[0].items[0].product_id).toBeNull();
    expect(shownTexts(ctx).filter((t) => t === AI_EXPIRED_TEXT)).toHaveLength(
      2,
    );
  });

  it('kutish muddati o‘tgan bo‘lsa matn odatdagidek ishlanadi', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['❓ Namuna atir — tanlash']);
    await press(ctx, buttons(ctx)['🔎 Qidirish']);
    const state = ctx.sessions.states.get('40')!;
    (state.ai_input as { at: number }).at = Date.now() - AI_INPUT_TTL_MS - 1;
    await send(ctx, 'qidirilgan krem');
    expect(calls.filter((c) => c.path.startsWith('/product/'))).toEqual([]);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
  });

  it('yaratilgan qoralamaning eski tanlash tugmasi — mahsulot o‘zgarmaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    await press(ctx, card['❓ Namuna atir — tanlash']);
    const picker = buttons(ctx);
    await press(ctx, picker['↩️ Orqaga']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(draftRow(ctx).status).toBe('created');
    await press(ctx, picker['✅ Namuna atir 1']);
    expect(draftRow(ctx).orders[0].items[0].product_id).toBeNull();
  });
});
