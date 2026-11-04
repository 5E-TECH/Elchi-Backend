import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  aiPreviewText,
  isCreatable,
  linkedReplacementId,
  toConfirmOrder,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * TGREPL — Telegram AI bot: ALMASHTIRISH (kafolat) BeePost boti kabi.
 * Gateway ai-parse preview'iga eski buyurtmani bog'laydi
 * (`replacement_lookup`, `replaced_order_id`, `replacement_candidates`); bot
 * uni kartada ko'rsatadi va ai-confirm'ga uzatadi. Eski buyurtma bog'langan
 * bo'lsa narx so'ralmaydi (bo'sh — yuborilmaydi, gateway 0 qo'yadi),
 * topilmasa oddiy buyurtma; tekshirib bo'lmagan / band / eski draft —
 * botdan yaratilmaydi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const DRAFT_ID = '11111111-2222-4333-8444-555555555555';

const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  order_number: `EL-${Number(id) + 100000}`,
  // 2026-10-31 20:30 UTC = 01.11.2026 01:30 Toshkent.
  created_at: '2026-10-31T20:30:00.000Z',
  items: 'Atir 50 ml ×2',
  total_price: 150000,
  ...extra,
});

const order = (extra: Partial<AiPreviewOrder> = {}): AiPreviewOrder => ({
  index: 0,
  ready: true,
  issues: [],
  customer_name: 'Ali Valiyev',
  phone_number: '+998901234567',
  extra_number: null,
  region_id: '3',
  region_name: 'Andijon',
  district_id: '12',
  district_name: 'Asaka',
  address: null,
  items: [
    {
      name: 'Atir 50ml',
      quantity: 1,
      product_id: '15',
      resolved_name: 'Atir 50 ml',
      unresolved: false,
    },
  ],
  total_price: 150000,
  where_deliver: 'address',
  comment: '[ALMASHTIRISH]',
  is_replacement: true,
  operator: null,
  ...extra,
});

/** Eski buyurtma bog'langan, narxsiz (gateway narx kamchiligini olib tashlagan). */
const linked = (extra: Partial<AiPreviewOrder> = {}) =>
  order({
    total_price: null,
    replacement_lookup: 'found',
    replaced_order_id: '555',
    replacement_candidates: [candidate('555')],
    replacement_candidates_total: 1,
    ...extra,
  });

/** Eski buyurtma topilmadi — oddiy buyurtma. */
const notFound = (extra: Partial<AiPreviewOrder> = {}) =>
  order({
    replacement_lookup: 'not_found',
    replaced_order_id: null,
    replacement_candidates: [],
    replacement_candidates_total: 0,
    ...extra,
  });

/** Qidiruv xato/timeout — "topilmadi" EMAS. */
const unavailable = (extra: Partial<AiPreviewOrder> = {}) =>
  notFound({ replacement_lookup: 'unavailable', ...extra });

describe('TGREPL — isCreatable', () => {
  it('bog‘langan almashtirish narxsiz ham tayyor (narx so‘ralmaydi)', () => {
    expect(isCreatable(linked())).toBe(true);
    // Gateway kamchilikni olib tashlamagan bo'lsa ham (eski javob) — narx
    // kamchiliklari bog'langan almashtirishni to'smaydi.
    expect(isCreatable(linked({ issues: ['price_missing'] }))).toBe(true);
    expect(
      isCreatable(linked({ total_price: 3000, issues: ['price_confirm'] })),
    ).toBe(true);
  });

  it('bog‘langan bo‘lsa ham boshqa kamchilik (tuman) — kabinetda', () => {
    expect(
      isCreatable(linked({ district_id: null, issues: ['district_missing'] })),
    ).toBe(false);
  });

  it('topilmagan almashtirish — oddiy buyurtma: narx bilan ha, narxsiz yo‘q', () => {
    expect(isCreatable(notFound())).toBe(true);
    expect(
      isCreatable(notFound({ total_price: null, issues: ['price_missing'] })),
    ).toBe(false);
  });

  it('id raqam bo‘lmasa yoki is_replacement=false — bog‘lanmagan hisoblanadi', () => {
    expect(linkedReplacementId(linked({ replaced_order_id: 'abc' }))).toBe(
      null,
    );
    expect(linkedReplacementId(linked({ is_replacement: false }))).toBeNull();
    expect(isCreatable(linked({ replaced_order_id: 'abc', issues: [] }))).toBe(
      false,
    );
    expect(linkedReplacementId(linked())).toBe('555');
  });

  it('⭐ qidiruv ishlamagan (unavailable) — narx bo‘lsa ham yaratilmaydi (oddiy buyurtma bo‘lib ketmaydi)', () => {
    expect(isCreatable(unavailable())).toBe(false);
    expect(isCreatable(notFound({ replacement_lookup: 'taken' }))).toBe(false);
  });

  it('⭐ eski draft (deploy’dan oldin, natija kaliti yo‘q) — ilgarigidek yaratilmaydi', () => {
    const stale = order({ total_price: 150000, issues: ['price_confirm'] });
    expect(stale).not.toHaveProperty('replacement_lookup');
    expect(isCreatable(stale)).toBe(false);
    // Kalit bor, lekin `found` emas — id bo'lsa ham bog'lanmaydi.
    expect(
      isCreatable(order({ replaced_order_id: '555', total_price: null })),
    ).toBe(false);
  });
});

describe('TGREPL — toConfirmOrder', () => {
  it('bog‘langan narxsiz: replaced_order_id, narx YUBORILMAYDI (gateway 0 — auditda soxta tuzatish yo‘q)', () => {
    const body = toConfirmOrder(linked(), DRAFT_ID);
    expect(body).toMatchObject({
      replaced_order_id: '555',
      draft_id: DRAFT_ID,
      ai_item_index: 0,
    });
    expect(body).not.toHaveProperty('total_price');
  });

  it('bog‘langan va narx berilgan — o‘sha narx', () => {
    expect(toConfirmOrder(linked({ total_price: 50000 }), null)).toMatchObject({
      replaced_order_id: '555',
      total_price: 50000,
    });
  });

  it('topilmagan / oddiy buyurtma — replaced_order_id YUBORILMAYDI', () => {
    expect(toConfirmOrder(notFound(), null)).not.toHaveProperty(
      'replaced_order_id',
    );
    expect(
      toConfirmOrder(order({ is_replacement: false }), null),
    ).not.toHaveProperty('replaced_order_id');
  });
});

describe('TGREPL — aiPreviewText', () => {
  it('bog‘langan: eski raqam, sana (Toshkent), mahsulot; narx 0 (almashtirish); narx kamchiligi ko‘rinmaydi', () => {
    const text = aiPreviewText([linked({ issues: ['price_missing'] })]);
    expect(text).toContain(
      '🔄 Almashtirish — eski №EL-100555 (01.11.2026, Atir 50 ml ×2) o‘rniga. Kuryer eskisini olib keladi.',
    );
    expect(text).not.toContain('yana');
    expect(text).toContain("💰 0 so'm (almashtirish)");
    expect(text).not.toContain("narx yo'q");
    expect(text).toContain('🟢');
  });

  it('bir nechta nomzod — "yana N ta": ✅ bosmaslik va kabinetda yaratish aytiladi', () => {
    const text = aiPreviewText([
      linked({
        replacement_candidates: [
          candidate('555'),
          candidate('400'),
          candidate('300'),
        ],
        replacement_candidates_total: 3,
      }),
    ]);
    expect(text).toContain(
      '(yana 2 ta — boshqasi kerak bo‘lsa «✅ Yaratish» ni bosmang, kabinetda yarating)',
    );
  });

  it('"yana N ta" — umumiy soni bo‘yicha (10 talik ro‘yxatdan ko‘p bo‘lsa ham)', () => {
    const text = aiPreviewText([
      linked({
        replacement_candidates: Array.from({ length: 10 }, (_, i) =>
          candidate(String(555 - i)),
        ),
        replacement_candidates_total: 25,
      }),
    ]);
    expect(text).toContain('(yana 24 ta —');
  });

  it('topilmadi — oddiy buyurtma qatori', () => {
    const text = aiPreviewText([notFound()]);
    expect(text).toContain(
      '🔄 Almashtirish — eski buyurtma topilmadi, oddiy buyurtma bo‘lib yaratiladi.',
    );
    expect(text).toContain("💰 150 000 so'm");
  });

  it('⭐ qidiruv ishlamadi — "topilmadi" deyilmaydi, 🟠 va kabinet/qayta yuborish', () => {
    const text = aiPreviewText([unavailable()]);
    expect(text).toContain(
      '🔄 Almashtirish — eski buyurtmani tekshirib bo‘lmadi, qayta yuboring yoki kabinetda yarating.',
    );
    expect(text).not.toContain('topilmadi');
    expect(text).toContain('🟠');
    expect(text).not.toContain('🟢');
    // Eski draft (kalitsiz) ham shunday.
    expect(aiPreviewText([order()])).toContain('tekshirib bo‘lmadi');
  });

  it('nomzodlar shu xabardagi boshqa almashtirishga band — kabinetda', () => {
    const text = aiPreviewText([
      notFound({
        replacement_lookup: 'taken',
        replacement_candidates: [candidate('555')],
      }),
    ]);
    expect(text).toContain(
      '🔄 Almashtirish — eski buyurtma shu xabardagi boshqa almashtirishga bog‘landi, buni kabinetda yarating.',
    );
    expect(text).toContain('🟠');
  });

  it('oddiy buyurtmada almashtirish qatori yo‘q', () => {
    expect(aiPreviewText([order({ is_replacement: false })])).not.toContain(
      '🔄',
    );
  });

  it('HTML: mahsulot nomi va raqam escape qilinadi', () => {
    const text = aiPreviewText([
      linked({
        replacement_candidates: [
          candidate('555', {
            items: '<b>Atir</b> & "krem" ×1',
            order_number: 'EL-<1>',
          }),
        ],
      }),
    ]);
    expect(text).toContain('&lt;b&gt;Atir&lt;/b&gt; &amp;');
    expect(text).toContain('№EL-&lt;1&gt;');
    expect(text).not.toContain('<b>Atir</b>');
  });

  it('uzunlik chegarasi: 10 ta bog‘langan almashtirish — 4096 dan kichik', () => {
    const long = 'Juda uzun mahsulot nomi '.repeat(10);
    const orders = Array.from({ length: 10 }, (_, index) =>
      linked({
        index,
        customer_name: 'M'.repeat(200),
        address: 'A'.repeat(200),
        replacement_candidates: Array.from({ length: 10 }, (_, i) =>
          candidate(String(555 + i), { items: long }),
        ),
      }),
    );
    expect(aiPreviewText(orders).length).toBeLessThanOrEqual(3902);
  });
});

describe('TGREPL — bot oqimi: preview kartasi → ✅ Yaratish → ai-confirm', () => {
  type GatewayCall = { path: string; body: unknown };

  const setup = (orders: AiPreviewOrder[]) => {
    const calls: GatewayCall[] = [];
    const gateway = jest.fn(
      (_tg: string, _method: string, path: string, body: unknown) => {
        calls.push({ path, body });
        if (path === '/orders/ai-parse') {
          return Promise.resolve({
            status: 200,
            body: { data: { ok: true, draft_id: DRAFT_ID, orders } },
          });
        }
        return Promise.resolve({
          status: 200,
          body: { data: { results: [{ index: 0, ok: true, order_id: '81' }] } },
        });
      },
    );
    const ctx = makeRouter({
      actor: {
        user_id: '40',
        role: 'market_operator',
        status: 'active',
        market_id: '37',
        region_id: null,
      },
      gateway,
      aiOrder: true,
    });
    return { ctx, calls };
  };

  const lastEdit = (ctx: ReturnType<typeof makeRouter>) =>
    ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      {
        text: string;
        reply_markup?: {
          inline_keyboard: Array<
            Array<{ text: string; callback_data?: string }>
          >;
        };
      },
    ];

  it('⭐ bog‘langan almashtirish: kartada 🔄 qatori, ai-confirm’da replaced_order_id (narxsiz)', async () => {
    const { ctx, calls } = setup([linked()]);
    await ctx.router.dispatch(
      'elchi',
      textUpdate('Ali +998901234567 atir buzuq, almashtirib bering', {
        chatId: 40,
        updateId: 7,
      }),
    );
    await ctx.aiService?.idle();
    const card = lastEdit(ctx)[2];
    expect(card.text).toContain('🔄 Almashtirish — eski №EL-100555');
    const create = (card.reply_markup?.inline_keyboard ?? [])
      .flat()
      .find((b) => b.text === '✅ Yaratish');
    expect(create?.callback_data).toBeDefined();
    // Telegram chegarasi: callback_data ≤ 64 bayt.
    expect(Buffer.byteLength(create!.callback_data!)).toBeLessThanOrEqual(64);

    await ctx.router.dispatch(
      'elchi',
      callbackUpdate(create!.callback_data!, { chatId: 40, fromId: 40 }),
    );
    await ctx.aiService?.idle();
    const confirm = calls.find((c) => c.path === '/orders/ai-confirm');
    const body = confirm?.body as { orders: Array<Record<string, unknown>> };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ replaced_order_id: '555' });
    expect(body.orders[0]).not.toHaveProperty('total_price');
  });

  it('qidiruv ishlamagan almashtirish (narx bor) — ✅ Yaratish tugmasi yo‘q', async () => {
    const { ctx } = setup([unavailable()]);
    await ctx.router.dispatch(
      'elchi',
      textUpdate('Ali +998901234567 almashtirish 150000', {
        chatId: 40,
        updateId: 9,
      }),
    );
    await ctx.aiService?.idle();
    const card = lastEdit(ctx)[2];
    expect(card.text).toContain('tekshirib bo‘lmadi');
    const texts = (card.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.text);
    expect(texts).not.toContain('✅ Yaratish');
  });

  it('topilmagan almashtirish narxsiz — tayyor emas, ✅ Yaratish tugmasi yo‘q', async () => {
    const { ctx } = setup([
      notFound({ total_price: null, issues: ['price_missing'] }),
    ]);
    await ctx.router.dispatch(
      'elchi',
      textUpdate('Ali +998901234567 almashtirish', { chatId: 40, updateId: 8 }),
    );
    await ctx.aiService?.idle();
    const card = lastEdit(ctx)[2];
    expect(card.text).toContain('eski buyurtma topilmadi');
    const texts = (card.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.text);
    expect(texts).not.toContain('✅ Yaratish');
  });
});
