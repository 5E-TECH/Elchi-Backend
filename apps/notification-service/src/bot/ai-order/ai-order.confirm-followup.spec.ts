import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_ALREADY_CREATED_TEXT } from './ai-order.service';
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
const lastShownText = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';

/** `editMessage` (va ixtiyoriy `outbox.send`) shu matnda yiqiladi. */
/**
 * Haqiqiy shakl: `BotTransportService.editMessage` xatoni YUTADI va `false`
 * qaytaradi (async) — `show` yangi xabarga (outbox) o'tadi; outbox shu
 * matnda yiqiladi: `alsoReply` — har safar, aks holda faqat BIRINCHI marta.
 */
function breakShow(ctx: Ctx, needle: string, alsoReply = false) {
  const edit = ctx.transport.editMessage.getMockImplementation()!;
  ctx.transport.editMessage.mockImplementation(((
    chatId: string,
    messageId: string,
    body: { text?: string },
  ) =>
    body?.text?.includes(needle)
      ? Promise.resolve(false)
      : edit(chatId, messageId, body)) as never);
  const send = ctx.outbox.send.getMockImplementation()!;
  let failed = false;
  ctx.outbox.send.mockImplementation(((message: { text?: string }) => {
    if (message?.text?.includes(needle) && (alsoReply || !failed)) {
      failed = true;
      return Promise.reject(new Error('outbox'));
    }
    return send(message as never);
  }) as never);
}

describe('1) yaratilgan qoralama preview’ga qaytmaydi', () => {
  it('natija xabarini ko‘rsatish yiqilsa ham status `created` qoladi, belgi yo‘q', async () => {
    const { ctx, calls } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    // Natija («yaratildi») xabari ko'rsatilmaydi — ishchi catch'ga tushadi.
    breakShow(ctx, 'yaratildi');
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

    // ✏️ — belgisiz buyurtma bitta: tanlashsiz darhol uning menyusi.
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(lastShownText(ctx)).toContain('2-buyurtma</b> — nimani tuzatamiz?');
    expect(Object.keys(buttons(ctx))).toContain('👤 Ism');
    await press(ctx, buttons(ctx)['↩️ Orqaga']);

    await press(ctx, buttons(ctx)['📍 2) Tumanni tanlash']);
    await press(ctx, buttons(ctx)['Birinchi tuman']);
    expect(row(ctx).orders[1].district_id).toBe('21');
    expect(row(ctx).orders[0].district_id).toBe('12');
  });
});

describe('#720 review', () => {
  /** n-buyurtma: tayyor yoki tumansiz (🟠, yuborilmaydi). */
  const nth = (index: number, ready: boolean) =>
    ready
      ? preview({
          index,
          customer_name: `Mijoz ${index + 1}`,
          phone_number: `+9989000000${String(index + 10)}`,
        })
      : { ...noDistrict(), index, customer_name: `Mijoz ${index + 1}` };

  it('MUST1: 12 buyurtma, belgililari bor — 📍 / ✏️ faqat kartadagi (≤10) belgisiz buyurtmaga', async () => {
    // 1–5, 7–10 tayyor (yuboriladi → belgi), 6, 11, 12 — tumansiz.
    const twelve = Array.from({ length: 12 }, (_, i) =>
      nth(i, i !== 5 && i < 10),
    );
    const { ctx } = setup(twelve, [new Error('timeout')]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(
      row(ctx).orders.filter((o: AiPreviewOrder) => o.confirm_attempted_at),
    ).toHaveLength(9);
    const keys = Object.keys(buttons(ctx));
    expect(keys.filter((k) => k.startsWith('📍'))).toEqual([
      '📍 6) Tumanni tanlash',
    ]);
    expect(keys).toContain('✏️ Tuzatish');
    expect(keys).toContain('🌐 Kabinetda yaratish');
    // Kartada belgisiz faqat 6-buyurtma — ✏️ darhol uning menyusi.
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(lastShownText(ctx)).toContain('6-buyurtma</b> — nimani tuzatamiz?');
  });

  it('MUST2: natija xabari yiqildi — saqlangan natija yangi xabar bilan (kabinet havolasi)', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    breakShow(ctx, 'yaratildi');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(sentTexts(ctx).at(-1)).toContain('Buyurtma');
    expect(sentTexts(ctx).at(-1)).toContain('yaratildi');
    expect(Object.keys(buttons(ctx))).toEqual(['🌐 Kabinetda yaratish']);
  });

  it('MUST2: natijani yangi xabar bilan ham yuborib bo‘lmasa — «allaqachon yaratilgan» + kabinet', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    breakShow(ctx, 'yaratildi', true);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(sentTexts(ctx).at(-1)).toBe(AI_ALREADY_CREATED_TEXT);
  });

  it('3: da‘vosini bo‘shatgan ish yangi `creating` da‘vosi ustidan preview yozmaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    const stale = { ...row(ctx), status: 'preview', worker_token: null };
    // Orada «✅» — yangi da'vo.
    Object.assign(row(ctx), { status: 'creating', worker_token: 'token-new' });
    const service = ctx.aiService as unknown as {
      backToPreview: (...args: unknown[]) => Promise<boolean>;
    };
    await expect(
      service.backToPreview({ chatId: '40' }, stale, 'x'),
    ).resolves.toBe(false);
    expect(row(ctx)).toEqual(
      expect.objectContaining({
        status: 'creating',
        worker_token: 'token-new',
      }),
    );
  });

  it('PG-1/5: karta 3900 belgida kesilsa — tugmalar faqat TO‘LIQ ko‘rsatilganlarga; «yana N ta» matni ✅ xatti-harakatiga mos', async () => {
    const long = (index: number): AiPreviewOrder =>
      preview({
        index,
        customer_name: `Mijoz ${index + 1}`,
        address: `Sintetik ko‘cha ${'uzun manzil '.repeat(9)}`.slice(0, 120),
        items: Array.from({ length: 8 }, (_, k) => ({
          name: `Namuna mahsulot uzun nomi ${k + 1} ${'x'.repeat(30)}`,
          quantity: 1,
          product_id: String(15 + k),
        })),
      });
    const ten = [
      ...Array.from({ length: 9 }, (_, i) => long(i)),
      { ...noDistrict(), index: 9, customer_name: 'Mijoz 10' },
    ];
    const { ctx } = setup(ten, [new Error('timeout')]);
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const card = lastShownText(ctx);
    expect(card).not.toContain('<b>10)</b>');
    expect(card).toContain('tayyorlari ham «✅ Yaratish» bilan yaratiladi');
    expect(card).toContain('✅ «Yaratish» — 9 ta tayyor buyurtma');
    const keys = Object.keys(buttons(ctx));
    expect(keys).not.toContain('📍 10) Tumanni tanlash');
    expect(keys).not.toContain('✏️ Tuzatish');
    expect(keys).toEqual(['✅ Yaratish', '❌ Bekor', '🌐 Kabinetda yaratish']);
  });

  it('PG-3: message_id saqlash yiqilsa natija IKKINCHI marta yuborilmaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    // Tahrir o'tmaydi → yangi xabar; uning id sini yozish yiqiladi.
    const edit = ctx.transport.editMessage.getMockImplementation()!;
    ctx.transport.editMessage.mockImplementation(((
      chatId: string,
      messageId: string,
      body: { text?: string },
    ) =>
      body?.text?.includes('yaratildi')
        ? Promise.resolve(false)
        : edit(chatId, messageId, body)) as never);
    const update = ctx.aiDrafts.update.getMockImplementation()!;
    ctx.aiDrafts.update.mockImplementation(((
      where: never,
      patch: Record<string, unknown>,
    ) =>
      'message_id' in patch && row(ctx).status === 'created'
        ? Promise.reject(new Error('db'))
        : update(where, patch as never)) as never);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(sentTexts(ctx).filter((t) => t.includes('yaratildi'))).toHaveLength(
      1,
    );
  });

  it('PG-4: boshqa replika yaratgan qoralama — tiklash natijani qayta yubormaydi', async () => {
    const { ctx } = setup([preview()]);
    await send(ctx, ORDER_TEXT);
    // Bu ish `creating` da (o'z finish(created) i yo'q), qatorni esa boshqa
    // replika `created` qilib, natijani o'zi ko'rsatgan.
    const mine = { ...row(ctx), status: 'creating', worker_token: null };
    Object.assign(row(ctx), {
      status: 'created',
      results: [{ index: 0, ok: true, order_id: '81' }],
    });
    const reply = jest.fn(() => Promise.resolve({ result: { message_id: 1 } }));
    const service = ctx.aiService as unknown as {
      recover: (...args: unknown[]) => Promise<void>;
    };
    await service.recover({ chatId: '40', reply }, mine, 'creating');
    expect(reply).not.toHaveBeenCalled();
    expect(row(ctx).status).toBe('created');
  });

  it('5: parse natijasi yozildi, karta ko‘rsatilmadi — `failed` ga aylanmaydi', async () => {
    const { ctx } = setup([preview()]);
    breakShow(ctx, 'buyurtma topdi');
    await send(ctx, ORDER_TEXT);
    expect(row(ctx).status).toBe('preview');
    expect(row(ctx).error).toBeNull();
  });
});
