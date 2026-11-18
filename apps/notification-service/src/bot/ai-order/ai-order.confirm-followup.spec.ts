import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_CONFIRM_UNKNOWN_LINE, type AiPreviewOrder } from './ai-preview';

/**
 * #713/#714 review davomi:
 *  1) natija xabari (show) yiqilsa ishchi `backToPreview` ga tushadi —
 *     `created` qoralama `preview` ga QAYTMAYDI (shartli yozuv);
 *  2) belgili (natijasi noma'lum) buyurtma bor kartada belgisiz
 *     (yuborilmagan) buyurtmaning 📍 / ❓ / ✏️ tugmalari ko'rinadi.
 * Barcha ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Test Mijoz 90 000 00 01 Test tuman, Namuna atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555f1';

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
  address: null,
  items: [{ name: 'Namuna atir', quantity: 2, product_id: '15' }],
  total_price: 150000,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: null,
  checks: [],
  ...extra,
});

/** 2-buyurtma: tuman aniqlanmadi (🟠) — yuborilmaydi. */
const noDistrict = () =>
  preview({
    index: 1,
    ready: false,
    customer_name: 'Ikkinchi Mijoz',
    phone_number: '+998900000002',
    issues: ['district_missing'],
    district_id: null,
    district_name: null,
    district_candidates: [
      {
        id: '21',
        label: 'Test viloyat, Birinchi tuman',
        region_name: 'Test viloyat',
      },
    ],
  });

type GatewayCall = { tg: string; method: string; path: string; body: unknown };
type Reply = { status: number; body: unknown } | Error;

function setup(orders: AiPreviewOrder[], confirm: Reply[] = []) {
  const calls: GatewayCall[] = [];
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
          body: { data: { results: [{ index: 0, ok: true, order_id: '81' }] } },
        };
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
const row = (ctx: Ctx) => [...ctx.aiDrafts.rows.values()][0];

describe('1) yaratilgan qoralama preview’ga qaytmaydi', () => {
  it('natija xabarini ko‘rsatish yiqilsa ham status `created` qoladi, belgi yo‘q', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    // Natija («yaratildi») xabari tahriri yiqiladi — ishchi catch'ga tushadi.
    const edit = ctx.transport.editMessage.getMockImplementation()!;
    ctx.transport.editMessage.mockImplementation(((
      chatId: string,
      messageId: string,
      body: { text?: string },
    ) => {
      if (body?.text?.includes('yaratildi')) throw new Error('telegram 500');
      return edit(chatId, messageId, body);
    }) as never);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(calls.filter((c) => c.path === '/orders/ai-confirm')).toHaveLength(
      1,
    );
    expect(row(ctx).status).toBe('created');
    expect(row(ctx).orders[0].confirm_attempted_at).toBeUndefined();
    expect(shownTexts(ctx).join('\n')).not.toContain(AI_CONFIRM_UNKNOWN_LINE);
  });
});

describe('2) belgili kartada yuborilmagan buyurtma tuzatiladi', () => {
  it('timeout: 1-buyurtma belgili, 2-si (🟠, yuborilmagan) — 📍 va ✏️ uning uchun ishlaydi', async () => {
    const { ctx } = setup([preview(), noDistrict()], [new Error('timeout')]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(row(ctx).orders[1].confirm_attempted_at).toBeUndefined();
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '📍 2) Tumanni tanlash',
      '✏️ Tuzatish',
      '❌ Bekor',
      '🌐 Kabinetda yaratish',
    ]);

    // ✏️ — faqat belgisiz buyurtma taklif qilinadi.
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(Object.keys(buttons(ctx))).toEqual([
      '2) Ikkinchi Mijoz',
      '↩️ Orqaga',
    ]);
    await press(ctx, buttons(ctx)['↩️ Orqaga']);

    await press(ctx, buttons(ctx)['📍 2) Tumanni tanlash']);
    await press(ctx, buttons(ctx)['Birinchi tuman']);
    expect(row(ctx).orders[1].district_id).toBe('21');
    expect(row(ctx).orders[0].district_id).toBe('12');
  });
});
