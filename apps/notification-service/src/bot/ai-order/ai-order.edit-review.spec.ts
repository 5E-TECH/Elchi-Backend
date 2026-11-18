import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_DISTRICT_LOAD_FAILED_TEXT,
  AI_EDIT_INPUT_TTL_MS,
  applyFieldEdit,
  containsUzPhone,
  endsEditInput,
} from './ai-order-edit';
import {
  AI_ACK_CONFIRM_TEXT,
  AI_ACK_SERVER_ASKED_TEXT,
  AI_CONFIRM_UNKNOWN_LINE,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * #714 review: noma'lum ai-confirm'dan keyin «✏️ Tuzatish» / tuman yopiq;
 * maydon kutilayotganda yangi buyurtma matni yutilmaydi; telefon tahririda
 * boshqa buyurtmadagi «shu telefon» ogohlantirishi; tumanlar ro'yxati
 * chegarasi va xatolari; ko'p buyurtma (o=1); tuman tahriridan keyin 409.
 * Barcha ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Test Mijoz 90 000 00 01 Test tuman, Namuna atir 2 ta, 150000';
const NEW_ORDER_TEXT =
  'Boshqa Mijoz 90 111 22 33 Chilonzor 5, krem 1 ta, 90000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555e1';

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
  comment: null,
  is_replacement: false,
  operator: null,
  checks: [],
  ...extra,
});

const lowConfidence = (extra: Partial<AiPreviewOrder> = {}) =>
  preview({
    district_match: { method: 'fuzzy', ai_text: 'Test tumn' },
    checks: [{ code: 'district_low_confidence' }],
    ...extra,
  });

type GatewayCall = { tg: string; method: string; path: string; body: unknown };
type Reply = { status: number; body: unknown } | Error;

const districts = (n: number) => ({
  status: 200,
  body: {
    data: Array.from({ length: n }, (_, k) => ({
      id: String(100 + k),
      name: `Tuman ${String(k + 1).padStart(2, '0')}`,
    })),
  },
});

function setup(
  orders: AiPreviewOrder[],
  options: { confirm?: Reply[]; district?: () => Reply } = {},
) {
  const calls: GatewayCall[] = [];
  const confirm = [...(options.confirm ?? [])];
  const gateway = jest.fn(
    (tg: string, method: string, path: string, body: unknown) => {
      calls.push({ tg, method, path, body });
      let reply: Reply = { status: 404, body: null };
      if (path === '/orders/ai-parse') {
        reply = {
          status: 200,
          body: { data: { ok: true, draft_id: DRAFT_ID, orders } },
        };
      } else if (path === '/orders/ai-confirm') {
        reply = confirm.shift() ?? {
          status: 200,
          body: {
            data: {
              results: (body as { orders: unknown[] }).orders.map((_o, i) => ({
                index: i,
                ok: true,
                order_id: String(81 + i),
              })),
            },
          },
        };
      } else if (path.startsWith('/district?')) {
        reply = options.district?.() ?? districts(2);
      }
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
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
const orders = (ctx: Ctx) =>
  [...ctx.aiDrafts.rows.values()][0].orders as AiPreviewOrder[];
const lastShown = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';
const parses = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-parse');
const confirms = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-confirm');
const input = (ctx: Ctx) => ctx.sessions.states.get('40')?.ai_input;

const LOCKED_KEYS = ['✅ Yaratish', '❌ Bekor', '🌐 Kabinetda yaratish'];

describe('BLOCKER (#714) — noma‘lum ai-confirm’dan keyin tuzatish menyusi yopiq', () => {
  it('⭐ timeout → eski ✏️ / maydon / 📍 / tuman tugmalari va kutilgan qiymat — hech narsa o‘zgarmaydi', async () => {
    const { ctx, calls } = setup([lowConfidence()], {
      confirm: [new Error('timeout')],
    });
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    await press(ctx, card['✏️ Tuzatish']);
    const menu = buttons(ctx);
    await press(ctx, menu['📍 Tuman']);
    const picker = buttons(ctx);
    await press(ctx, menu['👤 Ism']);
    // Ism kutilayotganda eski kartadan ✅ → «Baribir…» → ✅ Ha → timeout.
    await press(ctx, card['✅ Yaratish']);
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(confirms(calls)).toHaveLength(1);
    expect(typeof orders(ctx)[0].confirm_attempted_at).toBe('number');
    expect(lastShown(ctx)).toContain(AI_CONFIRM_UNKNOWN_LINE);
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);

    await send(ctx, 'Yangi Ism');
    expect(orders(ctx)[0].customer_name).toBe('Test Mijoz');
    expect(input(ctx)).toBeUndefined();

    await press(ctx, card['✏️ Tuzatish']);
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
    await press(ctx, menu['📞 Telefon']);
    expect(input(ctx)).toBeUndefined();
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
    await press(ctx, card['📍 Tumanni tanlash']);
    expect(Object.keys(buttons(ctx))).toEqual(LOCKED_KEYS);
    await press(ctx, picker['Tuman 01']);
    expect(orders(ctx)[0].district_id).toBe('12');
    expect(orders(ctx)[0].ai_district_id).toBeUndefined();
  });
});

describe('S1 — maydon kutilayotganda yangi buyurtma matni yutilmaydi', () => {
  it('endsEditInput / containsUzPhone qoidalari', () => {
    expect(endsEditInput('address', NEW_ORDER_TEXT)).toBe(true);
    expect(endsEditInput('address', 'Chilonzor 5-uy 12-xonadon')).toBe(false);
    expect(endsEditInput('comment', 'birinchi\nikkinchi')).toBe(true);
    expect(endsEditInput('comment', 'kech soat 18 dan keyin')).toBe(false);
    expect(endsEditInput('phone', '+998 90 111 22 33')).toBe(false);
    expect(endsEditInput('phone', 'Mijoz 90 111 22 33')).toBe(true);
    expect(endsEditInput('phone', '9'.repeat(41))).toBe(true);
    expect(endsEditInput('name', 'Yangi Mijoz')).toBe(false);
    expect(containsUzPhone('Chilonzor 5 90 111 22 33')).toBe(true);
    expect(containsUzPhone('uy 12, 150000 so‘m')).toBe(false);
  });

  it('manzil kutilayotganda yangi buyurtma matni — AI ga ketadi, manzil o‘zgarmaydi', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['🏠 Manzil']);
    await send(ctx, NEW_ORDER_TEXT);
    expect(parses(calls)).toHaveLength(2);
    expect(input(ctx)).toBeUndefined();
    expect(orders(ctx)[0].address).toBe('Test ko‘chasi 1');
  });

  it('maydon kutish muddati 5 daqiqa', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['💬 Izoh']);
    (input(ctx) as { at: number }).at = Date.now() - AI_EDIT_INPUT_TTL_MS - 1;
    await send(ctx, 'yangi izoh');
    expect(orders(ctx)[0].comment).toBeNull();
    expect(input(ctx)).toBeUndefined();
  });
});

describe('S4 — telefon tahriri «shu telefon N-buyurtmada ham bor» ni ikki tomondan oladi', () => {
  it('2-buyurtma telefoni o‘zgarsa 1-buyurtmadagi (other_index=1) ogohlantirish ham olinadi', () => {
    const two = [
      preview({ checks: [{ code: 'same_phone_multi', other_index: 1 }] }),
      preview({
        index: 1,
        checks: [{ code: 'same_phone_multi', other_index: 0 }],
      }),
    ];
    const next = applyFieldEdit(two, 1, 'phone', -1, '+998900000009')!;
    expect(next[0].checks).toEqual([]);
    expect(next[1].checks).toEqual([]);
    expect(next[1].phone_number).toBe('+998900000009');
  });
});

describe('S6/S7 — tumanlar ro‘yxati', () => {
  it('S6: 45 ta tuman — 40 ta tugma va «… yana 5 ta»', async () => {
    const { ctx } = setup([lowConfidence()], { district: () => districts(45) });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
    const keys = Object.keys(buttons(ctx));
    expect(keys.filter((k) => k.startsWith('Tuman '))).toHaveLength(40);
    expect(lastShown(ctx)).toContain('… yana 5 ta');
  });

  it.each([
    ['400', (): Reply => ({ status: 400, body: { message: 'yomon' } })],
    ['503', (): Reply => ({ status: 503, body: null })],
    ['tarmoq xatosi', (): Reply => new Error('ECONNRESET')],
  ])(
    'S7: /district %s — «olib bo‘lmadi», ro‘yxat saqlanmaydi',
    async (_n, district) => {
      const { ctx } = setup([lowConfidence()], { district });
      await send(ctx, ORDER_TEXT);
      await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
      expect(lastShown(ctx)).toBe(AI_DISTRICT_LOAD_FAILED_TEXT);
      expect(orders(ctx)[0].district_options).toBeUndefined();
      expect(Object.keys(buttons(ctx))).toEqual(['↩️ Orqaga']);
    },
  );

  it('S7: viloyat va nomzod yo‘q — kartada ham, menyuda ham 📍 yo‘q', async () => {
    const { ctx } = setup([
      preview({
        ready: false,
        issues: ['region_missing', 'district_missing'],
        region_id: null,
        region_name: null,
        district_id: null,
        district_name: null,
      }),
    ]);
    await send(ctx, ORDER_TEXT);
    expect(Object.keys(buttons(ctx))).toEqual(['✏️ Tuzatish', '❌ Bekor']);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(Object.keys(buttons(ctx))).not.toContain('📍 Tuman');
  });

  it('S7: ikki buyurtma — 2-buyurtmaning (o=1) ismi va tumani tuzatiladi, 1-si tegilmaydi', async () => {
    const { ctx, calls } = setup([
      preview(),
      lowConfidence({ index: 1, customer_name: 'Ikkinchi Mijoz' }),
    ]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['📍 2) Tumanni tanlash']);
    await press(ctx, buttons(ctx)['Tuman 02']);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    await press(ctx, buttons(ctx)['2) Ikkinchi Mijoz']);
    await press(ctx, buttons(ctx)['👤 Ism']);
    await send(ctx, 'Yangi Mijoz');
    expect(orders(ctx)[1]).toEqual(
      expect.objectContaining({
        customer_name: 'Yangi Mijoz',
        district_id: '101',
        ai_district_id: '12',
      }),
    );
    expect(orders(ctx)[0]).toEqual(
      expect.objectContaining({
        customer_name: 'Test Mijoz',
        district_id: '12',
      }),
    );
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const sent = (
      confirms(calls)[0].body as {
        orders: Array<Record<string, any>>;
      }
    ).orders;
    expect(sent[1]).toEqual(
      expect.objectContaining({ ai_item_index: 1, district_id: '101' }),
    );
    expect(sent[1].ack_checks).toBeUndefined();
  });

  it('S7: tuman tahriridan keyin server 409 so‘rasa — oyna, «✅ Ha» kodni yuboradi', async () => {
    const { ctx, calls } = setup([lowConfidence()], {
      confirm: [
        {
          status: 409,
          body: {
            code: 'CHECKS_NOT_ACKNOWLEDGED',
            orders: [{ index: 0, missing: ['district_low_confidence'] }],
          },
        },
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['📍 Tumanni tanlash']);
    await press(ctx, buttons(ctx)['Tuman 02']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(1);
    expect(lastShown(ctx)).toContain(AI_ACK_SERVER_ASKED_TEXT);
    expect(lastShown(ctx)).toContain(AI_ACK_CONFIRM_TEXT);
    // 409 — server yaratmadi: belgi yo'q.
    expect(orders(ctx)[0].confirm_attempted_at).toBeUndefined();
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(
      (confirms(calls)[1].body as { orders: Array<Record<string, unknown>> })
        .orders[0].ack_checks,
    ).toEqual(['district_low_confidence']);
  });
});
