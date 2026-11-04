import { Logger } from '@nestjs/common';
import {
  ACTION_CONSUMED_TEXT,
  ACTION_FOREIGN_TEXT,
} from '../bot-router.service';
import {
  callbackUpdate,
  courierActor,
  fakeOrdersGateway,
  gatewayOrder,
  lastButtons,
  makeRouter,
  openIshim,
  sentTexts,
  shownTexts,
} from '../testing/bot-kit-spec';
import {
  COURIER_ACTIONS,
  courierCardText,
  oldItemToCollect,
  toCourierOrderView,
} from './courier-cards';
import type { InlineKeyboardMarkup } from '../telegram.types';
import {
  COURIER_OLD_ITEM_ASK_TEXT,
  COURIER_OP_UNKNOWN_RETRY_TEXT,
} from './courier.handler';
import { courierOldItemRequiredText } from './courier.service';

/**
 * TGREPL (lQjt6sKP B) — kuryer boti almashtirish buyurtmasini sotadi:
 * kartada «🔄 eskisini olib keling» qatori, «✅ Sotildi» → «eskisini
 * oldingizmi?» → faqat «✅ Oldim — sotish» `oldItemCollected: true` yuboradi.
 * Soxta backend order-service darvozasini (`assertReplacementSaleAllowed`)
 * taqlid qiladi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

type Ctx = ReturnType<typeof makeRouter>;
type Call = [string, string, string, unknown?, { idempotencyKey?: string }?];

const press = (ctx: Ctx, data: string, fromId = 25) =>
  ctx.router.dispatch(
    'elchi',
    callbackUpdate(data, { chatId: fromId, fromId }),
  );

/** Telegram kabi: callback xabari o'z tugmalari (`reply_markup`) bilan keladi. */
const pressOn = (ctx: Ctx, data: string, markup: InlineKeyboardMarkup) => {
  const update = callbackUpdate(data, { chatId: 25, fromId: 25 });
  return ctx.router.dispatch('elchi', {
    ...update,
    callback_query: {
      ...update.callback_query,
      message: { ...update.callback_query.message, reply_markup: markup },
    },
  });
};

/** Oxirgi yuborilgan xabarning tugmalari (xom `reply_markup`). */
const lastMarkup = (ctx: Ctx): InlineKeyboardMarkup =>
  (
    ctx.outbox.send.mock.calls as unknown as Array<
      [{ reply_markup?: InlineKeyboardMarkup }]
    >
  ).at(-1)![0].reply_markup!;

let photoSeq = 8100;
const sendPhoto = (ctx: Ctx) => {
  photoSeq += 1;
  return ctx.router.dispatch('elchi', {
    update_id: photoSeq,
    message: {
      message_id: photoSeq,
      chat: { id: 25, type: 'private' },
      from: { id: 25 },
      photo: [{ file_id: `p${photoSeq}`, file_size: 10_000 }],
    },
  });
};

type Edit = [
  string,
  number | string,
  { text?: string; reply_markup?: InlineKeyboardMarkup },
];
const edits = (ctx: Ctx) =>
  ctx.transport.editMessage.mock.calls as unknown as Edit[];

const serverOldItemMessage = (oldId: string) =>
  `Bu almashtirish buyurtmasi (eski #${oldId} o'rniga). Avval eski mahsulotni mijozdan olganingizni tasdiqlang ("Eskisini oldim", old_item_collected: true) — tasdiqsiz sotib bo'lmaydi`;

const replacementOrder = (overrides: Record<string, unknown> = {}) =>
  gatewayOrder('101', 'waiting', {
    replacement_of_order_id: '55',
    replacement_state: 'awaiting_old_pickup',
    ...overrides,
  });

/**
 * `fakeOrdersGateway` + order-service almashtirish darvozasi: eski mahsulot
 * olinmagan almashtirishni `oldItemCollected: true` siz sotish — 400;
 * sotilgach holat `old_collected` (rollback'dan keyin ham shunday qoladi).
 */
function replacementBackend(orders: Array<Record<string, unknown>>) {
  const inner = fakeOrdersGateway(orders);
  const request = jest.fn(
    async (
      tg: string,
      method: string,
      path: string,
      body?: unknown,
      opts?: { idempotencyKey?: string },
    ) => {
      const sell = /^\/orders\/sell\/(\d+)$/.exec(path);
      const order = sell ? inner.orders.get(sell[1]) : undefined;
      if (method === 'POST' && order && order.status === 'waiting') {
        const awaiting =
          Boolean(order.replacement_of_order_id) &&
          !['old_collected', 'old_returned'].includes(
            String(order.replacement_state),
          );
        if (
          awaiting &&
          (body as { oldItemCollected?: unknown } | undefined)
            ?.oldItemCollected !== true
        ) {
          return {
            status: 400,
            body: {
              statusCode: 400,
              message: serverOldItemMessage(
                String(order.replacement_of_order_id),
              ),
            },
          };
        }
        const res = await inner.request(tg, method, path, body, opts);
        if (res.status === 200 && order.replacement_of_order_id) {
          order.replacement_state = 'old_collected';
        }
        return res;
      }
      return inner.request(tg, method, path, body, opts);
    },
  );
  const calls = () => request.mock.calls as unknown as Call[];
  const sells = () =>
    calls().filter(
      ([, method, path]) => method === 'POST' && /^\/orders\/sell\//.test(path),
    );
  return { request, inner, calls, sells };
}

const setup = (orders: Array<Record<string, unknown>>) => {
  const backend = replacementBackend(orders);
  const ctx = makeRouter({ actor: courierActor(), gateway: backend.request });
  return { ctx, backend };
};

const cardSends = (ctx: Ctx) =>
  (
    ctx.outbox.send.mock.calls as unknown as Array<
      [{ text: string; parse_mode?: string; source?: string }]
    >
  )
    .map(([message]) => message)
    .filter((message) => message.source === 'bot.courier_card');

const askText = (orderId = '101') =>
  `Buyurtma #${orderId} — ✅ Sotildi.\n${COURIER_OLD_ITEM_ASK_TEXT}`;

describe('TGREPL — kuryer boti: almashtirish buyurtmasini sotish', () => {
  it('⭐ oddiy buyurtma — o‘zgarishsiz: «Tasdiqlaysizmi?» → Ha → sell, oldItemCollected YO‘Q, 🔄 qatori yo‘q', async () => {
    const { ctx, backend } = setup([gatewayOrder('101', 'waiting')]);
    await openIshim(ctx);
    expect(cardSends(ctx).at(-1)!.text).not.toContain('🔄');
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    expect(sentTexts(ctx).at(-1)).toBe(
      'Buyurtma #101 — ✅ Sotildi. Tasdiqlaysizmi?',
    );
    expect(Object.keys(lastButtons(ctx))).toEqual(['✅ Ha', '⬅️ Orqaga']);
    // «✅ Sotildi» bosilganda qo'shimcha so'rov yo'q (avvalgidek).
    expect(backend.calls().map(([, m, p]) => `${m} ${p}`)).toEqual([
      'GET /orders?status=waiting&status=on+the+road&status=waiting_customer&page=1&limit=10',
      'GET /orders/101',
    ]);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    const [sell] = backend.sells();
    expect(sell[2]).toBe('/orders/sell/101');
    expect(sell[3]).toEqual({});
    expect(shownTexts(ctx)).toContain('#101 — sotildi ✅');
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
  });

  it('⭐ almashtirish: «✅ Sotildi» → savol; faqat «✅ Oldim — sotish» oldItemCollected: true yuboradi', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    expect(sentTexts(ctx).at(-1)).toBe(askText());
    expect(Object.keys(lastButtons(ctx))).toEqual([
      '✅ Oldim — sotish',
      '↩️ Ortga',
    ]);
    for (const data of Object.values(lastButtons(ctx))) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
    // Savolgacha hech narsa sotilmagan.
    expect(backend.sells()).toHaveLength(0);
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    const sells = backend.sells();
    expect(sells).toHaveLength(1);
    expect(sells[0][2]).toBe('/orders/sell/101');
    expect(sells[0][3]).toEqual({ oldItemCollected: true });
    // (BOT-3d) Kalit — «Oldim» tugmasining o'zi.
    expect(sells[0][4]?.idempotencyKey).toBeTruthy();
    expect(shownTexts(ctx)).toContain('#101 — sotildi ✅');
    const order = backend.inner.orders.get('101')!;
    expect(order.status).toBe('sold');
    expect(order.replacement_state).toBe('old_collected');
    // Karta yangilandi: 🔄 qatori yo'q, faqat «↩️ Ortga qaytarish».
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      {
        text: string;
        reply_markup: { inline_keyboard: Array<Array<{ text: string }>> };
      },
    ];
    expect(edit[2].text).not.toContain('🔄');
    expect(
      edit[2].reply_markup.inline_keyboard.flat().map((b) => b.text),
    ).toEqual(['↩️ Ortga qaytarish']);
  });

  it('⭐ «↩️ Ortga» — hech narsa yuborilmaydi, buyurtma o‘zgarmaydi', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['↩️ Ortga']);
    expect(sentTexts(ctx).at(-1)).toBe('⬅️ Amal bekor qilindi.');
    expect(backend.calls().some(([, method]) => method === 'POST')).toBe(false);
    expect(backend.inner.orders.get('101')!.status).toBe('waiting');
    expect(backend.inner.orders.get('101')!.replacement_state).toBe(
      'awaiting_old_pickup',
    );
  });

  it('⭐ boshqa kuryer «✅ Sotildi» / «✅ Oldim — sotish» ni bossa — rad, sotuv yo‘q', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    await openIshim(ctx);
    const sell = lastButtons(ctx)['✅ Sotildi'];
    await press(ctx, sell);
    const oldim = lastButtons(ctx)['✅ Oldim — sotish'];
    const asksBefore = sentTexts(ctx).length;
    ctx.actors.resolve.mockResolvedValue(courierActor('26'));
    await press(ctx, sell, 26);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_FOREIGN_TEXT,
    );
    await press(ctx, oldim, 26);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_FOREIGN_TEXT,
    );
    expect(sentTexts(ctx)).toHaveLength(asksBefore);
    expect(backend.sells()).toHaveLength(0);
    // Tugma yopilmadi — egasi baribir bosa oladi.
    ctx.actors.resolve.mockResolvedValue(courierActor('25'));
    await press(ctx, oldim);
    expect(backend.sells()).toHaveLength(1);
  });

  it('⭐ «✅ Oldim — sotish» ikki marta tez bosilsa — BITTA sotuv', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const oldim = lastButtons(ctx)['✅ Oldim — sotish'];
    await press(ctx, oldim);
    await press(ctx, oldim);
    expect(backend.sells()).toHaveLength(1);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_CONSUMED_TEXT,
    );
  });

  it('⭐ BOT-3d: javob yo‘qolsa «Oldim» qayta ochiladi — ayni kalit va ayni tana, backend’da BITTA amal', async () => {
    const backend = replacementBackend([replacementOrder()]);
    const cache = new Map<string, unknown>();
    let executed = 0;
    let lose = true;
    const request = jest.fn(
      async (
        tg: string,
        method: string,
        path: string,
        body?: unknown,
        opts?: { idempotencyKey?: string },
      ) => {
        const key = opts?.idempotencyKey;
        if (method === 'POST' && key && path === '/orders/sell/101') {
          if (cache.has(key)) return cache.get(key);
          executed += 1;
          const result = await backend.request(tg, method, path, body, opts);
          cache.set(key, result);
          if (lose) {
            lose = false;
            return { status: 504, body: { message: 'Gateway Timeout' } };
          }
          return result;
        }
        return backend.request(tg, method, path, body, opts);
      },
    );
    const ctx = makeRouter({ actor: courierActor(), gateway: request });
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const oldim = lastButtons(ctx)['✅ Oldim — sotish'];
    const question = lastMarkup(ctx);
    await pressOn(ctx, oldim, question);
    // Matn tugma nomini aytmaydi («✅ Ha» ekranda yo'q); xabarda faqat
    // bosilgan «Oldim» qoladi — «↩️ Ortga» natija noma'lum paytda «bekor
    // qilindi» deyolmasin.
    const retry = edits(ctx).find(
      ([, , edit]) => edit.text === COURIER_OP_UNKNOWN_RETRY_TEXT,
    );
    expect(retry).toBeDefined();
    expect(retry![1]).toBe(9);
    expect(COURIER_OP_UNKNOWN_RETRY_TEXT).not.toContain('✅ Ha');
    expect(retry![2].reply_markup).toEqual({
      inline_keyboard: [[{ text: '✅ Oldim — sotish', callback_data: oldim }]],
    });
    await press(ctx, oldim);
    const posts = (request.mock.calls as unknown as Call[]).filter(
      ([, method, path]) => method === 'POST' && path === '/orders/sell/101',
    );
    expect(posts).toHaveLength(2);
    expect(posts[1][4]?.idempotencyKey).toBe(posts[0][4]?.idempotencyKey);
    expect(posts[1][3]).toEqual(posts[0][3]);
    expect(posts[0][3]).toEqual({ oldItemCollected: true });
    expect(executed).toBe(1);
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
    expect(shownTexts(ctx)).toContain('#101 — sotildi ✅');
  });

  it('⭐ isbot talab qilinadi — «Oldim» → isbot → «Tugatdim»: proofFileKeys + oldItemCollected birga', async () => {
    const { ctx, backend } = setup([
      replacementOrder({
        market: { id: '3', expense_proof_conditions: ['sell_any'] },
      }),
    ]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    expect(backend.sells()).toHaveLength(0);
    expect(ctx.sessions.states.get('25')?.proof).toEqual(
      expect.objectContaining({
        op: 'sell',
        order_id: '101',
        keys: [],
        old_item_collected: true,
      }),
    );
    const done = lastButtons(ctx)['✅ Tugatdim'];
    await ctx.router.dispatch('elchi', {
      update_id: 8101,
      message: {
        message_id: 8101,
        chat: { id: 25, type: 'private' },
        from: { id: 25 },
        photo: [{ file_id: 'p1', file_size: 10_000 }],
      },
    });
    await press(ctx, done);
    const [sell] = backend.sells();
    expect(sell[3]).toEqual({
      proofFileKeys: ['proof-1'],
      oldItemCollected: true,
    });
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
  });

  it('⭐ «Oldim» → isbot rejimi: savol tugmalari olinadi; eski «↩️ Ortga» bosilsa isbot rejimi YOPILADI — rasm qabul qilinmaydi, «Tugatdim» sotmaydi', async () => {
    const { ctx, backend } = setup([
      replacementOrder({
        market: { id: '3', expense_proof_conditions: ['sell_any'] },
      }),
    ]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const { '✅ Oldim — sotish': oldim, '↩️ Ortga': ortga } = lastButtons(ctx);
    await pressOn(ctx, oldim, lastMarkup(ctx));
    // Savol xabari (9) — matn o'zgarmaydi, tugmalar olinadi.
    expect(edits(ctx).at(-1)).toEqual([
      '25',
      9,
      { reply_markup: { inline_keyboard: [] } },
    ]);
    const done = lastButtons(ctx)['✅ Tugatdim'];
    expect(ctx.sessions.states.get('25')?.proof).toBeDefined();
    // Boshqa buyurtmaning «Orqaga» si bu isbotga tegmaydi.
    const otherBack = await ctx.actions.create({
      chatId: '25',
      action: COURIER_ACTIONS.back,
      actorUserId: '25',
      orderId: '999',
      payload: {},
      oneShot: false,
    });
    await press(ctx, otherBack);
    expect(ctx.sessions.states.get('25')?.proof).toBeDefined();
    // Eski xabardagi «↩️ Ortga» (masalan ikki marta ochilgan savol).
    await press(ctx, ortga);
    expect(sentTexts(ctx).at(-1)).toBe('⬅️ Amal bekor qilindi.');
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
    await sendPhoto(ctx);
    expect(sentTexts(ctx).join('\n')).not.toContain('Qabul qilindi');
    expect(backend.calls().some(([, , path]) => path === '/files/upload')).toBe(
      false,
    );
    await press(ctx, done);
    expect(sentTexts(ctx).at(-1)).toBe('Isbot kutilayotgan amal yo‘q.');
    expect(backend.sells()).toHaveLength(0);
    expect(backend.inner.orders.get('101')!.status).toBe('waiting');
  });

  it('⭐ isbot oqimida server «eskisini oldim» ni so‘rasa — isbot holati tozalanadi, karta 🔄 bilan, savol; keyin «Oldim» → isbot → sotuv', async () => {
    // Deploydan oldingi holat: isbot rejimi `old_item_collected` siz ochilgan
    // (karta ochilganda buyurtma oddiy edi), sotuv paytida esa server uni
    // eski mahsulot olinmagan almashtirish deb biladi.
    const { ctx, backend } = setup([
      gatewayOrder('101', 'waiting', {
        market: { id: '3', expense_proof_conditions: ['sell_any'] },
      }),
    ]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(ctx.sessions.states.get('25')?.proof).toEqual({
      op: 'sell',
      order_id: '101',
      reason: null,
      keys: [],
    });
    Object.assign(backend.inner.orders.get('101')!, {
      replacement_of_order_id: '55',
      replacement_state: 'awaiting_old_pickup',
    });
    const done = lastButtons(ctx)['✅ Tugatdim'];
    await sendPhoto(ctx);
    await press(ctx, done);
    expect(backend.sells()).toHaveLength(1);
    expect(backend.sells()[0][3]).toEqual({ proofFileKeys: ['proof-1'] });
    expect(shownTexts(ctx)).toContain(courierOldItemRequiredText('101'));
    // Eskirgan isbot holati yopildi — keyingi rasm unga qo'shilmaydi.
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
    const cardEdit = edits(ctx).find(([, , edit]) =>
      edit.text?.includes('🔄 Almashtirish'),
    );
    expect(cardEdit?.[2].text).toContain('(№EL-100055)');
    expect(sentTexts(ctx).at(-1)).toBe(askText());
    expect(backend.inner.orders.get('101')!.status).toBe('waiting');

    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    expect(ctx.sessions.states.get('25')?.proof).toEqual(
      expect.objectContaining({ keys: [], old_item_collected: true }),
    );
    const done2 = lastButtons(ctx)['✅ Tugatdim'];
    await sendPhoto(ctx);
    await press(ctx, done2);
    expect(backend.sells()).toHaveLength(2);
    expect(backend.sells()[1][3]).toEqual({
      proofFileKeys: ['proof-2'],
      oldItemCollected: true,
    });
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
    expect(ctx.sessions.states.get('25')?.proof).toBeUndefined();
  });

  it('⭐ rollback oynasi: sotuv → «↩️ Ortga qaytarish» → qayta sotuv eski «Tasdiqlaysizmi?» bilan (eskisi allaqachon olingan)', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
    const rollback = ctx.actions.dataOf(COURIER_ACTIONS.op).at(-1)!;
    await press(ctx, rollback);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(backend.inner.orders.get('101')!.status).toBe('waiting');
    expect(backend.inner.orders.get('101')!.replacement_state).toBe(
      'old_collected',
    );
    // Yangilangan karta: 🔄 qatori yo'q, «✅ Sotildi» oddiy tasdiq so'raydi.
    const sell = ctx.actions.dataOf(COURIER_ACTIONS.op).at(-2)!;
    expect(ctx.actions.rows.get(sell.slice(2))!.payload).toEqual({
      op: 'sell',
    });
    await press(ctx, sell);
    expect(sentTexts(ctx).at(-1)).toBe(
      'Buyurtma #101 — ✅ Sotildi. Tasdiqlaysizmi?',
    );
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(backend.sells().at(-1)![3]).toEqual({});
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
  });

  it('⭐ eskirgan tugma (almashtirish belgisisiz «✅ Sotildi») — «Ha» dan keyin sotuv emas, savol', async () => {
    const { ctx, backend } = setup([replacementOrder()]);
    // Deploydan oldingi karta tugmasi: payload faqat { op: 'sell' }.
    const oldSell = await ctx.actions.create({
      chatId: '25',
      action: COURIER_ACTIONS.op,
      actorUserId: '25',
      orderId: '101',
      payload: { op: 'sell' },
      oneShot: false,
    });
    await press(ctx, oldSell);
    expect(sentTexts(ctx).at(-1)).toBe(
      'Buyurtma #101 — ✅ Sotildi. Tasdiqlaysizmi?',
    );
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(backend.sells()).toHaveLength(0);
    expect(sentTexts(ctx).at(-1)).toBe(askText());
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    expect(backend.sells()).toHaveLength(1);
    expect(backend.sells()[0][3]).toEqual({ oldItemCollected: true });
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
  });

  it('⭐ gateway baribir «eskisini oldim» xatosini qaytarsa — aniq o‘zbekcha matn, karta yangilanadi, savol beriladi', async () => {
    const { ctx, backend } = setup([gatewayOrder('101', 'waiting')]);
    await openIshim(ctx);
    // Karta ochilgandan keyin buyurtma almashtirish bo'lib chiqdi (eskirgan
    // karta) va GET ham ishlamay qoldi — tekshiruvni faqat server qiladi.
    Object.assign(backend.inner.orders.get('101')!, {
      replacement_of_order_id: '55',
      replacement_state: 'awaiting_old_pickup',
    });
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const yes = lastButtons(ctx)['✅ Ha'];
    const original = backend.request.getMockImplementation()!;
    backend.request.mockImplementationOnce(() =>
      Promise.resolve({ status: 503, body: null }),
    );
    await press(ctx, yes);
    backend.request.mockImplementation(original);
    expect(shownTexts(ctx)).toContain(courierOldItemRequiredText('101'));
    expect(shownTexts(ctx).join('\n')).not.toContain('Amal bajarilmadi');
    expect(shownTexts(ctx).join('\n')).not.toContain('old_item_collected');
    // Karta 🔄 qatori bilan yangilandi.
    const cardEdit = ctx.transport.editMessage.mock.calls
      .map((call) => (call as unknown[])[2] as { text?: string })
      .find((payload) => payload.text?.includes('🔄 Almashtirish'));
    expect(cardEdit).toBeDefined();
    expect(sentTexts(ctx).at(-1)).toBe(askText());
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    expect(backend.sells().at(-1)![3]).toEqual({ oldItemCollected: true });
    expect(backend.inner.orders.get('101')!.status).toBe('sold');
  });

  it('«Oldim» bilan ham server rad etsa — xabar, savol qayta berilmaydi (sikl yo‘q)', async () => {
    const gateway = fakeOrdersGateway([replacementOrder()], {
      op: (op) =>
        op === 'sell'
          ? {
              status: 400,
              body: { statusCode: 400, message: serverOldItemMessage('55') },
            }
          : undefined,
    });
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await openIshim(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['✅ Oldim — sotish']);
    const asks = sentTexts(ctx).filter((text) => text === askText());
    expect(asks).toHaveLength(1);
    expect(shownTexts(ctx)).toContain(courierOldItemRequiredText('101'));
  });

  it('⭐ karta: 🔄 qatori (eski raqam bilan) va HTML ekranlangan; olingan / sotilgan holatda qator yo‘q', async () => {
    const { ctx } = setup([replacementOrder()]);
    await openIshim(ctx);
    const card = cardSends(ctx).at(-1)!;
    expect(card.parse_mode).toBe('HTML');
    expect(card.text).toContain(
      '🔄 Almashtirish — mijozdan eski mahsulotni (№EL-100055) olib keling.',
    );
    const evil = toCourierOrderView(
      replacementOrder({ replacement_of_order_id: '<b>55&' }),
    )!;
    const text = courierCardText(evil);
    expect(text).toContain('(№&lt;b&gt;55&amp;)');
    expect(text).not.toContain('<b>55');
    expect(text.length).toBeLessThanOrEqual(4096);
    for (const overrides of [
      { replacement_state: 'old_collected' },
      { replacement_state: 'old_returned' },
      { status: 'sold' },
      { status: 'cancelled' },
      { replacement_of_order_id: null, replacement_state: null },
    ]) {
      const view = toCourierOrderView(replacementOrder(overrides))!;
      expect(courierCardText(view)).not.toContain('🔄');
    }
    // Yo'lda / mijoz kutilmoqda — eslatma bor (sotuvgacha).
    for (const status of ['on the road', 'waiting_customer']) {
      const view = toCourierOrderView(replacementOrder({ status }))!;
      expect(courierCardText(view)).toContain('(№EL-100055)');
    }
  });

  it('oldItemToCollect — order-service darvozasi bilan bir xil qoida', () => {
    const view = (overrides: Record<string, unknown>) =>
      toCourierOrderView(replacementOrder(overrides))!;
    expect(oldItemToCollect(view({}))).toBe('55');
    // Holat yo'q (eski yozuv) — server baribir tasdiq so'raydi.
    expect(oldItemToCollect(view({ replacement_state: null }))).toBe('55');
    expect(
      oldItemToCollect(view({ replacement_state: 'old_collected' })),
    ).toBeNull();
    expect(
      oldItemToCollect(view({ replacement_state: 'old_returned' })),
    ).toBeNull();
    expect(
      oldItemToCollect(
        view({ replacement_of_order_id: null, replacement_state: null }),
      ),
    ).toBeNull();
  });
});
