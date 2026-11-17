import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_CHECKS_RETRY_TEXT, AI_DRAFT_GONE_TEXT } from './ai-order.service';
import {
  AI_ACK_CONFIRM_TEXT,
  AI_ACK_SERVER_ASKED_TEXT,
  ackPromptText,
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

type ConfirmReply = { status: number; body: unknown };

/** Sukut: har yuborilgan buyurtma yaratildi. */
const okReply = (body: unknown): ConfirmReply => {
  const sent = (body as { orders?: unknown[] }).orders ?? [];
  return {
    status: 200,
    body: {
      data: {
        results: sent.map((_o, index) => ({
          index,
          ok: true,
          order_id: String(81 + index),
        })),
      },
    },
  };
};

function setup(
  orders: AiPreviewOrder[],
  confirmReplies: Array<(body: unknown) => ConfirmReply> = [],
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
        return Promise.resolve((confirmReplies.shift() ?? okReply)(body));
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
    // B3: ack_checks — faqat operator oynada tasdiqlagan kodlar.
    expect(toConfirmOrder(order, DRAFT_ID)).not.toHaveProperty('ack_checks');
    expect(
      toConfirmOrder(
        {
          ...order,
          acked_checks: ['price_check', 'district_low_confidence', 'x'],
        },
        DRAFT_ID,
      ).ack_checks,
    ).toEqual(['district_low_confidence', 'price_check']);
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

const sentOrders = (calls: GatewayCall[], n = 0) =>
  (confirms(calls)[n].body as { orders: Array<Record<string, unknown>> })
    .orders;
const lastText = (ctx: Ctx) => lastEdit(ctx)[2].text;
const draftRow = (ctx: Ctx) => [...ctx.aiDrafts.rows.values()][0];
const fakeCtx = () =>
  ({
    chatId: '40',
    fromId: '40',
    isPrivate: true,
    reply: jest.fn(() => Promise.resolve({ result: {} })),
  }) as never;

describe('AI ack round-3 — B3: faqat KO‘RSATILGAN ogohlantirish tasdiqlanadi', () => {
  it('⭐ 12 ta tayyor buyurtma, #12 da price_check — oynada aniq «12) ⚠️» qatori, ack faqat shunga', async () => {
    const orders = Array.from({ length: 12 }, (_, i) =>
      preview(i, {
        total_price: 150000,
        phone_number: `+9989012345${String(i).padStart(2, '0')}`,
        checks:
          i === 11
            ? [{ code: 'price_check', kind: 'mismatch', mentions: [99000] }]
            : [],
      }),
    );
    const { ctx, calls } = setup(orders);
    await send(ctx, ORDER_TEXT);
    // Preview kartasi 10 tadan keyin kesiladi — #12 u yerda ko'rinmaydi.
    expect(lastText(ctx)).not.toContain('<b>12)</b>');

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const prompt = lastText(ctx);
    expect(prompt).toContain(AI_ACK_CONFIRM_TEXT);
    expect(prompt).not.toContain('yuqorida');
    expect(prompt).toContain('<b>12)</b> ⚠️');
    expect(prompt).toContain(
      '⚠️ Summa matndagidan farq qiladi: matnda 99 000, AI 150 000',
    );
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Ha, yaratish',
      '↩️ Yo‘q, orqaga',
    ]);

    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    const sent = sentOrders(calls);
    expect(sent).toHaveLength(12);
    expect(sent.filter((o) => 'ack_checks' in o)).toEqual([
      expect.objectContaining({
        ai_item_index: 11,
        ack_checks: ['price_check'],
      }),
    ]);
  });

  it('⭐ 6 ta uzun buyurtma (preview 3900 belgida kesiladi), #6 da tuman — oynada #6 ko‘rinadi va faqat u tasdiqlanadi', async () => {
    const long = 'Juda uzun manzil matni '.repeat(30);
    const orders = Array.from({ length: 6 }, (_, i) =>
      preview(i, {
        total_price: 150000,
        phone_number: `+9989012345${String(i).padStart(2, '0')}`,
        address: long,
        comment: long,
        items: Array.from({ length: 8 }, (_x, k) => ({
          name: `${'&'.repeat(58)} ${k}`,
          quantity: 1,
          product_id: '15',
        })),
        checks: i === 5 ? [{ code: 'district_low_confidence' }] : [],
      }),
    );
    expect(aiPreviewText(orders)).not.toContain('<b>6)</b>');
    const { ctx, calls } = setup(orders);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastText(ctx)).toContain('<b>6)</b> ⚠️');
    expect(lastText(ctx)).toContain(
      '⚠️ Tuman aniq emas: AI «Asakaa» deb o‘qidi — tekshiring',
    );
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(
      sentOrders(calls)
        .filter((o) => 'ack_checks' in o)
        .map((o) => [o.ai_item_index, o.ack_checks]),
    ).toEqual([[5, ['district_low_confidence']]]);
  });

  it('ro‘yxat sig‘maydi (>10 ta ogohlantirishli) — «Ha» YO‘Q, kabinetga yo‘naltiriladi, hech narsa yuborilmaydi', async () => {
    const orders = Array.from({ length: 11 }, (_, i) =>
      preview(i, {
        phone_number: `+9989012345${String(i).padStart(2, '0')}`,
        checks: [{ code: 'district_low_confidence' }],
      }),
    );
    const { ctx, calls } = setup(orders);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastText(ctx)).toContain('kabinetda tekshirib yarating');
    const keyboard = (lastEdit(ctx)[2].reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.text);
    expect(keyboard).toContain('🌐 Kabinetda yaratish');
    expect(keyboard).not.toContain('✅ Ha, yaratish');
    expect(confirms(calls)).toHaveLength(0);
  });

  it('ackPromptText — matn 3900 belgidan oshsa fits=false', () => {
    // HTML qochirish (& → &amp;) matnni 5 baravar uzaytiradi.
    const huge = '&'.repeat(500);
    const targets = Array.from({ length: 10 }, (_, i) => ({
      order: preview(i, {
        customer_name: huge,
        district_match: { ai_text: huge },
        checks: [{ code: 'district_low_confidence' }],
      }),
      codes: ['district_low_confidence'],
    }));
    const prompt = ackPromptText(targets);
    expect(prompt.fits).toBe(false);
    expect(prompt.text.length).toBeLessThan(4096);
  });

  it('eski «Ha» tugmasi (payload’da `acks` yo‘q) — hech narsa yuborilmaydi, oyna qayta ko‘rsatiladi', async () => {
    const { ctx, calls } = setup([
      preview(0, { checks: [{ code: 'district_low_confidence' }] }),
    ]);
    await send(ctx, ORDER_TEXT);
    await ctx.aiService!.confirmAcked(
      fakeCtx(),
      String(draftRow(ctx).id),
      undefined,
    );
    await ctx.aiService!.idle();
    expect(confirms(calls)).toHaveLength(0);
    expect(draftRow(ctx).status).toBe('preview');
    expect(lastText(ctx)).toContain(AI_ACK_CONFIRM_TEXT);
  });

  it('acked_checks ko‘rsatilmagan buyurtmaga yetmasa — yuborilmaydi, «kabinetda yarating» qatori', async () => {
    const { ctx, calls } = setup([
      preview(0, { total_price: 150000, checks: [] }),
      preview(1, {
        phone_number: '+998901234500',
        checks: [{ code: 'price_check', kind: 'too_high', mentions: [] }],
      }),
    ]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    // Oynada faqat #2 — lekin «Ha» payload'i bo'sh deb faraz qilamiz
    // (masalan oynadan keyin preview o'zgargan): #2 yuborilmasligi shart.
    await ctx.aiService!.confirmAcked(fakeCtx(), String(draftRow(ctx).id), []);
    await ctx.aiService!.idle();
    expect(sentOrders(calls).map((o) => o.ai_item_index)).toEqual([0]);
    expect(lastText(ctx)).toContain(
      '⚠️ 2) AI ogohlantirishi tasdiqlanmagan — kabinetda yarating',
    );
  });
});

describe('AI ack round-3 — S3: ai-confirm xatolari', () => {
  const blockingOrder = () =>
    preview(0, { checks: [{ code: 'district_low_confidence' }] });

  it('409 CHECKS_NOT_ACKNOWLEDGED — server `missing` bilan oyna qayta, «Ha» shu kodlarni yuboradi', async () => {
    const { ctx, calls } = setup(
      [blockingOrder()],
      [
        () => ({
          status: 409,
          body: {
            statusCode: 409,
            code: 'CHECKS_NOT_ACKNOWLEDGED',
            message: 'AI ogohlantirishlari tasdiqlanmagan: …',
            missing: ['price_check'],
            orders: [{ index: 0, missing: ['price_check'] }],
          },
        }),
      ],
    );
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(sentOrders(calls, 0)[0].ack_checks).toEqual([
      'district_low_confidence',
    ]);
    // Server summani ham so'radi — oyna qayta, ikkala kod bilan.
    expect(draftRow(ctx).status).toBe('preview');
    expect(lastText(ctx)).toContain(AI_ACK_SERVER_ASKED_TEXT);
    expect(lastText(ctx)).toContain('⚠️ Summa matndagidan farq qiladi');
    expect(lastText(ctx)).not.toContain('AI ogohlantirishlari tasdiqlanmagan');
    await press(ctx, buttons(ctx)['✅ Ha, yaratish']);
    expect(confirms(calls)).toHaveLength(2);
    expect(sentOrders(calls, 1)[0].ack_checks).toEqual([
      'district_low_confidence',
      'price_check',
    ]);
    expect(lastText(ctx)).toContain('yaratildi');
  });

  it('503 AI_CHECKS_UNAVAILABLE — «birozdan so‘ng qayta urinib ko‘ring», preview tugmalari', async () => {
    const { ctx } = setup(
      [preview(0, { total_price: 150000 })],
      [
        () => ({
          status: 503,
          body: {
            statusCode: 503,
            code: 'AI_CHECKS_UNAVAILABLE',
            message: 'server matni',
            retryable: true,
            retry_after_seconds: 5,
          },
        }),
      ],
    );
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(lastText(ctx)).toContain(AI_CHECKS_RETRY_TEXT);
    expect(lastText(ctx)).toContain('birozdan so‘ng qayta urinib ko‘ring');
    expect(lastText(ctx)).not.toContain('server matni');
    expect(draftRow(ctx).status).toBe('preview');
    expect(Object.keys(buttons(ctx))).toContain('✅ Yaratish');
  });

  it.each([
    'AI_DRAFT_NOT_FOUND',
    'AI_DRAFT_ITEM_NOT_FOUND',
    'AI_DRAFT_REQUIRED',
  ])(
    '400 %s — tushunarli matn (server matni emas), kabinet tugmasi',
    async (code) => {
      const { ctx } = setup(
        [preview(0, { total_price: 150000 })],
        [
          () => ({
            status: 400,
            body: {
              statusCode: 400,
              code,
              message: 'texnik matn',
              indexes: [0],
            },
          }),
        ],
      );
      await send(ctx, ORDER_TEXT);
      await press(ctx, buttons(ctx)['✅ Yaratish']);
      expect(lastText(ctx)).toBe(AI_DRAFT_GONE_TEXT);
      expect(draftRow(ctx).status).toBe('failed');
      const keyboard = (lastEdit(ctx)[2].reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((b) => b.text);
      expect(keyboard).toEqual(['🌐 Kabinetda yaratish']);
    },
  );
});
