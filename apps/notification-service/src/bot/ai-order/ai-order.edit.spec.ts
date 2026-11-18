import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_EXPIRED_TEXT } from './ai-order.service';
import {
  AI_EDIT_ERRORS,
  applyDistrictPick,
  parseEditValue,
} from './ai-order-edit';
import {
  AI_ACK_CONFIRM_TEXT,
  blockingCheckCodes,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * Bot AI preview: «✏️ Tuzatish» — maydonni tanlash → yangi qiymat → tekshiruv
 * → karta qayta; tuman yo'q / AI ikkilangan — nomzod yoki viloyat
 * tumanlaridan tanlash. Tuman tahriri AI ack qoidasiga mos: AI taklifidan
 * boshqa tuman — `district_low_confidence` so'ralmaydi. Barcha ma'lumot
 * soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Test Mijoz 90 000 00 01 Test tuman, Namuna atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555c1';

const preview = (extra: Partial<AiPreviewOrder> = {}): AiPreviewOrder => ({
  index: 0,
  ready: true,
  issues: [],
  customer_name: 'Test Mijoz',
  phone_number: '+998900000001',
  extra_number: null,
  region_id: '3',
  region_name: 'Test viloyat',
  district_id: '12',
  district_name: 'Test tuman',
  address: 'Test ko‘chasi 1',
  items: [{ name: 'Namuna atir', quantity: 2, product_id: '15' }],
  total_price: 150000,
  where_deliver: 'address',
  comment: 'eski izoh',
  is_replacement: false,
  operator: null,
  checks: [],
  ...extra,
});

/** Tuman aniqlanmadi — AI nomzodlari bilan. */
const missingDistrict = () =>
  preview({
    ready: false,
    issues: ['district_missing'],
    district_id: null,
    district_name: null,
    district_candidates: [
      {
        id: '21',
        label: 'Test viloyat, Birinchi tuman',
        region_name: 'Test viloyat',
      },
      {
        id: '22',
        label: 'Test viloyat, Ikkinchi tuman',
        region_name: 'Test viloyat',
      },
    ],
  });

/** Tuman AI tanladi, lekin ikkilandi (bloklovchi). */
const lowConfidence = () =>
  preview({
    district_match: { method: 'fuzzy', ai_text: 'Test tumn' },
    checks: [{ code: 'district_low_confidence' }],
  });

type GatewayCall = { tg: string; method: string; path: string; body: unknown };

function setup(orders: AiPreviewOrder[]) {
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
      if (path.startsWith('/district?')) {
        return Promise.resolve({
          status: 200,
          body: {
            statusCode: 200,
            data: [
              { id: '13', name: 'Uchinchi tuman', region_id: '3' },
              { id: '12', name: 'Test tuman', region_id: '3' },
            ],
          },
        });
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
const draftOrder = (ctx: Ctx) =>
  [...ctx.aiDrafts.rows.values()][0].orders[0] as AiPreviewOrder;
const lastShown = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';
const confirms = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-confirm');
const confirmOrder = (calls: GatewayCall[]) =>
  (confirms(calls)[0].body as { orders: Array<Record<string, any>> }).orders[0];

describe('ai-order-edit — qiymat tekshiruvi', () => {
  it('telefon — repo normalizeUzPhone (+998…), noto‘g‘risi rad', () => {
    expect(parseEditValue('phone', '90 000 00 09')).toEqual({
      ok: true,
      value: '+998900000009',
    });
    expect(parseEditValue('phone', '+998 90 000 00 09')).toEqual({
      ok: true,
      value: '+998900000009',
    });
    expect(parseEditValue('phone', '12345')).toEqual({
      ok: false,
      error: AI_EDIT_ERRORS.phone,
    });
  });

  it('ism / soni / manzil / izoh chegaralari', () => {
    expect(parseEditValue('name', ' Yangi  Mijoz ')).toEqual({
      ok: true,
      value: 'Yangi Mijoz',
    });
    expect(parseEditValue('name', '7')).toMatchObject({ ok: false });
    expect(parseEditValue('qty', '12')).toEqual({ ok: true, value: 12 });
    expect(parseEditValue('qty', '0')).toMatchObject({ ok: false });
    expect(parseEditValue('qty', '2.5')).toMatchObject({ ok: false });
    expect(parseEditValue('address', '-')).toEqual({ ok: true, value: null });
    expect(parseEditValue('address', 'ab')).toMatchObject({ ok: false });
    expect(parseEditValue('comment', '-')).toEqual({ ok: true, value: null });
  });

  it('ack: AI tumanidan boshqasi — district_low_confidence bloklamaydi; o‘shasi qayta tanlansa — bloklaydi', () => {
    const order = lowConfidence();
    expect(blockingCheckCodes(order)).toEqual(['district_low_confidence']);
    const other = applyDistrictPick([order], 0, {
      id: '13',
      name: 'Uchinchi tuman',
    })[0];
    expect(other.ai_district_id).toBe('12');
    expect(blockingCheckCodes(other)).toEqual([]);
    const same = applyDistrictPick([other], 0, {
      id: '12',
      name: 'Test tuman',
    })[0];
    expect(same.ai_district_id).toBe('12');
    expect(blockingCheckCodes(same)).toEqual(['district_low_confidence']);
  });
});

describe('bot — tumanni tanlash', () => {
  it('⭐ tuman aniqlanmadi → «📍 Tumanni tanlash» → AI nomzodi → district_id, karta 🟢, confirm district_id bilan', async () => {
    const { ctx, calls } = setup([missingDistrict()]);
    await send(ctx, ORDER_TEXT);
    expect(Object.keys(buttons(ctx))).toEqual([
      '📍 Tumanni tanlash',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
    expect(lastShown(ctx)).toContain('AI taklif qilgan tumanlar');
    const picker = buttons(ctx);
    expect(Object.keys(picker)).toEqual([
      'Birinchi tuman',
      'Ikkinchi tuman',
      '↩️ Orqaga',
    ]);
    const row = [...ctx.actions.rows.values()].find(
      (r) => `a:${r.action_id}` === picker['Ikkinchi tuman'],
    )!;
    expect(row.payload).toEqual(
      expect.objectContaining({ o: 0, s: 'c', k: 1 }),
    );

    await press(ctx, picker['Ikkinchi tuman']);
    expect(draftOrder(ctx)).toEqual(
      expect.objectContaining({
        district_id: '22',
        district_name: 'Ikkinchi tuman',
        issues: [],
      }),
    );
    expect(lastShown(ctx)).toContain('🟢');
    expect(lastShown(ctx)).toContain('Test viloyat, Ikkinchi tuman');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmOrder(calls)).toEqual(
      expect.objectContaining({ district_id: '22' }),
    );
    expect(confirmOrder(calls).customer.district_id).toBe('22');
  });

  it('⭐ AI ikkilangan tuman → viloyat tumanlari (GET /district) → boshqasini tanlash — ack so‘ralmaydi', async () => {
    const { ctx, calls } = setup([lowConfidence()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
    expect(calls.filter((c) => c.path.startsWith('/district'))).toEqual([
      expect.objectContaining({
        tg: '40',
        method: 'GET',
        path: '/district?region_id=3',
      }),
    ]);
    // Nom bo'yicha tartib; joriy tuman «•» bilan.
    expect(Object.keys(buttons(ctx))).toEqual([
      '• Test tuman',
      'Uchinchi tuman',
      '↩️ Orqaga',
    ]);
    await press(ctx, buttons(ctx)['Uchinchi tuman']);
    expect(draftOrder(ctx).district_id).toBe('13');
    expect(lastShown(ctx)).not.toContain('Tuman aniq emas');
    expect(Object.keys(buttons(ctx))).not.toContain('📍 Tumanni tanlash');

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(shownTexts(ctx).some((t) => t.includes(AI_ACK_CONFIRM_TEXT))).toBe(
      false,
    );
    expect(confirmOrder(calls).district_id).toBe('13');
    expect(confirmOrder(calls).ack_checks).toBeUndefined();
  });

  it('AI tanlagan tumanning o‘zini tanlash — tahrir emas, «Baribir yaratamanmi?» qoladi', async () => {
    const { ctx, calls } = setup([lowConfidence()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
    await press(ctx, buttons(ctx)['• Test tuman']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastShown(ctx)).toContain(AI_ACK_CONFIRM_TEXT);
    expect(confirms(calls)).toHaveLength(0);
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(confirmOrder(calls).ack_checks).toEqual(['district_low_confidence']);
  });
});

describe('bot — ✏️ Tuzatish menyusi', () => {
  it('⭐ telefon: noto‘g‘ri → xato, kutish davom etadi; to‘g‘ri → normallashgan, karta yangi xabarda', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(Object.keys(buttons(ctx))).toEqual([
      '👤 Ism',
      '📞 Telefon',
      '🏠 Manzil',
      '💬 Izoh',
      '🔢 Soni: Namuna atir',
      '📍 Tuman',
      '↩️ Orqaga',
    ]);
    expect([...ctx.aiDrafts.rows.values()][0].status).toBe('preview');
    await press(ctx, buttons(ctx)['📞 Telefon']);
    expect(lastShown(ctx)).toContain('Mijoz telefonini yozib yuboring');
    expect(ctx.sessions.states.get('40')?.ai_input).toEqual(
      expect.objectContaining({ kind: 'edit', f: 'phone', o: 0 }),
    );

    await send(ctx, '123');
    expect(lastShown(ctx)).toBe(AI_EDIT_ERRORS.phone);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeDefined();

    // 7+ raqam — telefon kutilayotganda yangi buyurtma emas.
    await send(ctx, '90 000 00 09');
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(1);
    expect(draftOrder(ctx).phone_number).toBe('+998900000009');
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    expect(lastShown(ctx)).toContain('+998900000009');
    expect(Object.keys(buttons(ctx))).toContain('✅ Yaratish');

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmOrder(calls).customer.phone_number).toBe('+998900000009');
  });

  it('ism yo‘q (🟠) → ism yozildi → 🟢 va yaratiladi', async () => {
    const { ctx, calls } = setup([
      preview({ ready: false, customer_name: '', issues: ['name_missing'] }),
    ]);
    await send(ctx, ORDER_TEXT);
    expect(Object.keys(buttons(ctx))).not.toContain('✅ Yaratish');
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['👤 Ism']);
    await send(ctx, 'Yangi Mijoz');
    expect(draftOrder(ctx)).toEqual(
      expect.objectContaining({ customer_name: 'Yangi Mijoz', issues: [] }),
    );
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirmOrder(calls).customer.name).toBe('Yangi Mijoz');
  });

  it('soni, manzil, izoh («-» — o‘chirish) → confirm yangi qiymatlar bilan; qty_check olinadi', async () => {
    const { ctx, calls } = setup([
      preview({ checks: [{ code: 'qty_check', item_index: 0 }] }),
    ]);
    await send(ctx, ORDER_TEXT);
    expect(lastShown(ctx)).toContain('Soni shubhali');

    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['🔢 Soni: Namuna atir']);
    await send(ctx, '0');
    expect(lastShown(ctx)).toBe(AI_EDIT_ERRORS.qty);
    await send(ctx, '3');
    expect(lastShown(ctx)).toContain('Namuna atir ×3');
    expect(lastShown(ctx)).not.toContain('Soni shubhali');

    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['🏠 Manzil']);
    await send(ctx, 'Yangi ko‘cha 5');
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['💬 Izoh']);
    await send(ctx, '-');

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const sent = confirmOrder(calls);
    expect(sent.items).toEqual([{ product_id: '15', quantity: 3 }]);
    expect(sent.address).toBe('Yangi ko‘cha 5');
    expect(sent.customer.address).toBe('Yangi ko‘cha 5');
    expect(sent.comment).toBeUndefined();
  });

  it('«↩️ Orqaga» — kutish bekor, qiymat o‘zgarmaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['👤 Ism']);
    await press(ctx, buttons(ctx)['↩️ Orqaga']);
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
    expect(lastShown(ctx)).toContain('AI 1 ta buyurtma topdi');
    await send(ctx, 'Boshqa ism');
    expect(draftOrder(ctx).customer_name).toBe('Test Mijoz');
  });

  it('eskirgan qoralama: menyu tugmasi va kutilgan qiymat — «eskirgan», hech narsa o‘zgarmaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    const menu = buttons(ctx);
    await press(ctx, menu['👤 Ism']);
    [...ctx.aiDrafts.rows.values()][0].expires_at = new Date(Date.now() - 1000);

    await send(ctx, 'Boshqa Mijoz');
    expect(shownTexts(ctx)).toContain(AI_EXPIRED_TEXT);
    expect(draftOrder(ctx).customer_name).toBe('Test Mijoz');

    await press(ctx, menu['📞 Telefon']);
    expect(shownTexts(ctx).filter((t) => t === AI_EXPIRED_TEXT)).toHaveLength(
      2,
    );
    expect(ctx.sessions.states.get('40')?.ai_input).toBeUndefined();
  });
});
