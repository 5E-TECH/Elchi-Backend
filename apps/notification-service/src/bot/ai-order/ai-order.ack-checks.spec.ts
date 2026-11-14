import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_ACK_CONFIRM_TEXT,
  aiCheckLines,
  aiPreviewText,
  blockingCheckCodes,
  needsAckConfirm,
  toConfirmOrder,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * AI ack (ega qarori 2026-11-14) — bot: preview'da AI tekshiruvlari «⚠️»
 * qatorlari; bloklovchi (`district_low_confidence`, `price_check`) bo'lsa
 * «✅ Yaratish» avval «Baribir yaratamanmi?» deb so'raydi, keyin ai-confirm
 * `ack_checks` bilan. Barcha ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT = 'Test Mijoz 90 123 45 67 Asaka, Atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555a1';

const preview = (
  index: number,
  extra: Partial<AiPreviewOrder> = {},
): AiPreviewOrder => ({
  index,
  ready: true,
  issues: [],
  customer_name: 'Test Mijoz',
  phone_number: '+998901234567',
  extra_number: null,
  region_id: '3',
  region_name: 'Andijon',
  district_id: '12',
  district_name: 'Asaka',
  address: null,
  items: [{ name: 'Atir', quantity: 2, product_id: '15' }],
  total_price: 15000,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: null,
  district_match: { method: 'fuzzy', ai_text: 'Asakaa' },
  checks: [],
  ...extra,
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
          body: {
            data: { results: [{ index: 0, ok: true, order_id: '81' }] },
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
    } as never,
    gateway,
    aiOrder: true,
  });
  return { ctx, calls };
}

type Ctx = ReturnType<typeof makeRouter>;
type EditCall = [
  string,
  string,
  {
    text: string;
    reply_markup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
    };
  },
];
const lastEdit = (ctx: Ctx) =>
  (ctx.transport.editMessage.mock.calls as unknown as EditCall[]).at(-1)!;
const buttons = (ctx: Ctx): Record<string, string> =>
  Object.fromEntries(
    (lastEdit(ctx)[2].reply_markup?.inline_keyboard ?? [])
      .flat()
      .filter((b) => b.callback_data)
      .map((b) => [b.text, b.callback_data!]),
  );
const settle = async <T>(ctx: Ctx, p: Promise<T>) => {
  const result = await p;
  await ctx.aiService?.idle();
  return result;
};
const send = (ctx: Ctx, text: string) =>
  settle(
    ctx,
    ctx.router.dispatch('elchi', textUpdate(text, { chatId: 40, updateId: 1 })),
  );
const press = (ctx: Ctx, data: string) =>
  settle(
    ctx,
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: 40, fromId: 40 }),
    ),
  );
const confirms = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-confirm');

describe('aiCheckLines — oddiy tildagi ogohlantirishlar', () => {
  it('tuman aniq emas — AI o‘qigan matn bilan (HTML qochirilgan)', () => {
    expect(
      aiCheckLines(
        preview(0, {
          district_match: { ai_text: 'Asaka <tuman>' },
          checks: [{ code: 'district_low_confidence' }],
        }),
      ),
    ).toEqual([
      '⚠️ Tuman aniq emas: AI «Asaka &lt;tuman&gt;» deb o‘qidi — tekshiring',
    ]);
    expect(
      aiCheckLines(
        preview(0, {
          district_match: null,
          checks: [{ code: 'district_low_confidence' }],
        }),
      ),
    ).toEqual(['⚠️ Tuman aniq emas — tekshiring']);
  });

  it('summa: mismatch (matnda / AI) va too_high', () => {
    expect(
      aiCheckLines(
        preview(0, {
          checks: [
            { code: 'price_check', kind: 'mismatch', mentions: [150000] },
          ],
        }),
      ),
    ).toEqual(['⚠️ Summa matndagidan farq qiladi: matnda 150 000, AI 15 000']);
    expect(
      aiCheckLines(
        preview(0, {
          total_price: 250000000,
          checks: [{ code: 'price_check', kind: 'too_high', mentions: [] }],
        }),
      ),
    ).toEqual(['⚠️ Summa juda katta: 250 000 000 — matnni tekshiring']);
  });

  it('yumshoq tekshiruvlar qisqa qatorlar; noma’lum kod — qatorsiz', () => {
    expect(
      aiCheckLines(
        preview(0, {
          checks: [
            { code: 'qty_check', item_index: 0 },
            { code: 'duplicate_items', item_indexes: [0, 1] },
            { code: 'phone_is_market' },
            { code: 'same_phone_multi', other_index: 1 },
            { code: 'future_check' },
          ],
        }),
      ),
    ).toEqual([
      '⚠️ Soni shubhali: Atir ×2',
      '⚠️ Bir xil mahsulot ikki marta yozilgan',
      '⚠️ Mijoz telefoni — marketning o‘z raqami',
      '⚠️ Shu telefon 2-buyurtmada ham bor',
    ]);
  });

  it('preview kartasida qatorlar chiqadi', () => {
    const text = aiPreviewText([
      preview(0, {
        checks: [
          { code: 'price_check', kind: 'mismatch', mentions: [150000] },
          { code: 'phone_is_market' },
        ],
      }),
    ]);
    expect(text).toContain(
      '⚠️ Summa matndagidan farq qiladi: matnda 150 000, AI 15 000',
    );
    expect(text).toContain('⚠️ Mijoz telefoni — marketning o‘z raqami');
  });

  it('blockingCheckCodes / ack_checks — faqat bloklovchi kodlar, qat’iy tartibda', () => {
    const order = preview(0, {
      checks: [
        { code: 'price_check', kind: 'mismatch', mentions: [150000] },
        { code: 'qty_check', item_index: 0 },
        { code: 'district_low_confidence' },
        { code: 'price_check', kind: 'too_high', mentions: [] },
      ],
    });
    expect(blockingCheckCodes(order)).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
    expect(toConfirmOrder(order, DRAFT_ID).ack_checks).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
    const soft = preview(0, { checks: [{ code: 'phone_is_market' }] });
    expect(toConfirmOrder(soft, DRAFT_ID)).not.toHaveProperty('ack_checks');
    // Yaratilmaydigan (🟠) buyurtmaning tekshiruvi qayta so'rovga olib kelmaydi.
    expect(
      needsAckConfirm([
        preview(0, {
          district_id: null,
          issues: ['district_missing'],
          checks: [{ code: 'district_low_confidence' }],
        }),
      ]),
    ).toBe(false);
  });
});

describe('«✅ Yaratish» — bloklovchi tekshiruvda qayta tasdiq', () => {
  const blocking = () =>
    setup([
      preview(0, {
        checks: [
          { code: 'district_low_confidence' },
          { code: 'price_check', kind: 'mismatch', mentions: [150000] },
          { code: 'qty_check', item_index: 0 },
        ],
      }),
    ]);

  it('⭐ «Baribir yaratamanmi?» → «✅ Ha, yaratish» → ai-confirm ack_checks bilan', async () => {
    const { ctx, calls } = blocking();
    await send(ctx, ORDER_TEXT);
    expect(lastEdit(ctx)[2].text).toContain(
      '⚠️ Tuman aniq emas: AI «Asakaa» deb o‘qidi — tekshiring',
    );

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(0);
    expect(lastEdit(ctx)[2].text).toContain(AI_ACK_CONFIRM_TEXT);
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Ha, yaratish',
      '↩️ Yo‘q, orqaga',
    ]);
    // Qoralama hali preview'da — hech narsa yaratilmagan.
    expect([...ctx.aiDrafts.rows.values()][0].status).toBe('preview');

    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(confirms(calls)).toHaveLength(1);
    const body = confirms(calls)[0].body as {
      orders: Array<Record<string, unknown>>;
    };
    expect(body.orders[0].ack_checks).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
    expect(lastEdit(ctx)[2].text).toContain('yaratildi');
  });

  it('«↩️ Yo‘q, orqaga» — preview tugmalari qaytadi, ai-confirm chaqirilmaydi', async () => {
    const { ctx, calls } = blocking();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['↩️ Yo‘q, orqaga']);
    expect(confirms(calls)).toHaveLength(0);
    expect(lastEdit(ctx)[2].text).not.toContain(AI_ACK_CONFIRM_TEXT);
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    // Qayta «✅ Yaratish» — yana so'raydi.
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastEdit(ctx)[2].text).toContain(AI_ACK_CONFIRM_TEXT);
    expect(confirms(calls)).toHaveLength(0);
  });

  it('bloklovchi tekshiruv yo‘q (faqat yumshoq) — avvalgidek darhol yaratiladi, ack_checks yo‘q', async () => {
    const { ctx, calls } = setup([
      preview(0, {
        total_price: 150000,
        checks: [{ code: 'phone_is_market' }],
      }),
    ]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(1);
    const body = confirms(calls)[0].body as {
      orders: Array<Record<string, unknown>>;
    };
    expect(body.orders[0]).not.toHaveProperty('ack_checks');
  });
});
