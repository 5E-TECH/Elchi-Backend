import { Logger } from '@nestjs/common';
import {
  COURIER_ACTIONS,
  COURIER_LIST_EXPIRED_TEXT,
  courierCardText,
  formatSum,
  opsForStatus,
  toCourierOrderView,
} from './courier-cards';
import {
  COMMAND_GROUP_DENIED_TEXT,
  COMMAND_NOT_LINKED_TEXT,
} from '../handlers/command-gate.handler';
import {
  callbackUpdate,
  courierActor,
  fakeOrdersGateway,
  gatewayOrder,
  lastButtons,
  makeRouter,
  openIshim,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  ACTION_CONSUMED_TEXT,
  ACTION_FOREIGN_TEXT,
} from '../bot-router.service';

/**
 * h9newLsd (kuryer menyusi, /ishim) + MO2MLPGo (4 holat tugmasi). Hamma
 * amal kuryerning o'z JWT'si bilan MAVJUD gateway endpointlari orqali
 * (soxta gateway server qoidalarini taqlid qiladi).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const press = (
  ctx: ReturnType<typeof makeRouter>,
  data: string,
  fromId = 25,
  chatId = 25,
) => ctx.router.dispatch('elchi', callbackUpdate(data, { chatId, fromId }));

describe('h9newLsd — /ishim', () => {
  it('⭐ bog‘lanmagan chat /ishim — faqat "avval ulang", birorta buyurtma yo‘q', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({ actor: null, gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    expect(sentTexts(ctx)).toEqual([COMMAND_NOT_LINKED_TEXT]);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it('⭐ A kuryer faqat o‘z buyurtmalarini ko‘radi (server doirasi), tuman bo‘yicha guruhlangan', async () => {
    const gateway = fakeOrdersGateway([
      gatewayOrder('101', 'waiting'),
      gatewayOrder('102', 'on the road', { district: { name: 'Chilonzor' } }),
      gatewayOrder('201', 'waiting', { courier_id: '26' }),
    ]);
    const ctx = makeRouter({
      actor: courierActor('25'),
      gateway: gateway.request,
    });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    const [listCall] = gateway.calls;
    expect(listCall.method).toBe('GET');
    expect(listCall.path).toMatch(
      /^\/orders\?status=waiting&status=on\+the\+road&status=waiting_customer&page=1&limit=10$/,
    );
    const texts = sentTexts(ctx);
    // (BOT-3d) BITTA ro'yxat xabari (12 emas) — kartalar tugma bilan ochiladi.
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('jami 2 ta');
    expect(texts[0]).toContain('📍 Chilonzor — 1 ta');
    expect(texts[0]).toContain('#101');
    expect(texts[0]).toContain('#102');
    expect(texts[0]).not.toContain('#201');
    expect(Object.keys(lastButtons(ctx))).toEqual(['#102', '#101']);
    expect(ctx.cards.rows.size).toBe(0);
    // Tugma — karta (saqlanadi, keyin tahrirlash uchun).
    await press(ctx, lastButtons(ctx)['#101']);
    expect(sentTexts(ctx)).toHaveLength(2);
    expect(ctx.cards.rows.size).toBe(1);
  });

  it('⭐ WAITING kartada Sotildi/Bekor (+ kabinet), ON_THE_ROAD — Yetkazib bo‘lmadi, SOLD — faqat Ortga', () => {
    expect(opsForStatus('waiting')).toEqual(['sell', 'cancel']);
    expect(opsForStatus('on the road')).toEqual(['cnd']);
    expect(opsForStatus('sold')).toEqual(['rollback']);
    expect(opsForStatus('cancelled')).toEqual(['rollback']);
    expect(opsForStatus('paid')).toEqual([]);
  });

  it('karta tugmalari: WAITING → ✅ Sotildi, ❌ Bekor, 🌐 Kabinetda ochish (partly-sell tugma emas)', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await openIshim(ctx);
    const buttons = lastButtons(ctx);
    expect(Object.keys(buttons)).toEqual([
      '✅ Sotildi',
      '❌ Bekor',
      '🌐 Kabinetda ochish',
    ]);
    expect(buttons['🌐 Kabinetda ochish']).toBe(
      'https://admin.elchi.test/orders?search=101',
    );
    for (const data of [buttons['✅ Sotildi'], buttons['❌ Bekor']]) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('⭐ 10 tadan ortiq — sahifalash, "⬇️ Yana" ikkinchi sahifani beradi', async () => {
    const orders = Array.from({ length: 13 }, (_, i) =>
      gatewayOrder(String(300 + i), 'waiting'),
    );
    const gateway = fakeOrdersGateway(orders);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    const more = lastButtons(ctx)['⬇️ Yana'];
    expect(more).toBeDefined();
    expect(
      Object.keys(lastButtons(ctx)).filter((text) => text.startsWith('#3')),
    ).toHaveLength(10);
    expect(sentTexts(ctx)).toHaveLength(1);
    await press(ctx, more);
    expect(gateway.calls.at(-1)?.path).toContain('page=2');
    // (BOT-3d) «Yana» shu xabarni TAHRIRLAYDI (yangi xabar emas).
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      number,
      { text: string },
    ];
    expect(edit[2].text).toContain('#312');
    expect(edit[2].text).toContain('2-sahifa');
    expect(sentTexts(ctx)).toHaveLength(1);
    // "Yana" bir martalik emas — qayta bosilsa ham ishlaydi.
    await press(ctx, more);
    expect(
      gateway.calls.filter((call) => call.path.includes('page=2')),
    ).toHaveLength(2);
  });

  it('⭐ BOT-3d: ro‘yxat tugmalarining callback_data ≤64 bayt', async () => {
    const orders = Array.from({ length: 13 }, (_, i) =>
      gatewayOrder(String(9_000_000_000_000 + i), 'waiting'),
    );
    const gateway = fakeOrdersGateway(orders);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    const data = Object.values(lastButtons(ctx)).filter((value) =>
      value.startsWith('a:'),
    );
    expect(data.length).toBeGreaterThanOrEqual(11);
    for (const value of data) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('⭐ BOT-3d: eski (deploydan oldingi) /ishim tugmalari ishlaydi — karta amali va «⬇️ Yana»', async () => {
    const orders = Array.from({ length: 13 }, (_, i) =>
      gatewayOrder(String(300 + i), 'waiting'),
    );
    const gateway = fakeOrdersGateway(orders);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    // Eski versiya yaratgan tugmalar: karta «✅ Sotildi» va ro'yxat «⬇️ Yana».
    const actorUserId = '25';
    const oldSell = await ctx.actions.create({
      chatId: '25',
      action: COURIER_ACTIONS.op,
      actorUserId,
      orderId: '300',
      payload: { op: 'sell' },
      oneShot: false,
    });
    const oldMore = await ctx.actions.create({
      chatId: '25',
      action: COURIER_ACTIONS.page,
      actorUserId,
      payload: { page: 2 },
      oneShot: false,
    });
    await press(ctx, oldSell);
    expect(sentTexts(ctx).at(-1)).toBe(
      'Buyurtma #300 — ✅ Sotildi. Tasdiqlaysizmi?',
    );
    await press(ctx, oldMore);
    expect(gateway.calls.at(-1)?.path).toContain('page=2');
    expect(
      [
        ...sentTexts(ctx),
        ...ctx.transport.editMessage.mock.calls.map(
          (call) => ((call as unknown[])[2] as { text?: string }).text ?? '',
        ),
      ].join('\n'),
    ).toContain('2-sahifa');
  });

  it('muddati o‘tgan ro‘yxat tugmasi — "bu ro‘yxat eskirgan, /ishim ni qayta yuboring"', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await openIshim(ctx);
    const sell = lastButtons(ctx)['✅ Sotildi'];
    const row = ctx.actions.rows.get(sell.slice(2))!;
    row.expires_at = new Date(Date.now() - 1);
    await press(ctx, sell);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      COURIER_LIST_EXPIRED_TEXT,
    );
  });

  it('⭐ /ishim guruh chatida — rad, kartalar guruhga chiqmaydi', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await ctx.router.dispatch(
      'elchi',
      textUpdate('/ishim', {
        chatId: -100555,
        chatType: 'supergroup',
        fromId: 25,
      }),
    );
    expect(sentTexts(ctx)).toEqual([COMMAND_GROUP_DENIED_TEXT]);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it('karta matni ≤4096, pul numeric satrdan to‘g‘ri formatlanadi', () => {
    const view = toCourierOrderView(
      gatewayOrder('101', 'waiting', {
        total_price: '1250000.50',
        customer: { name: 'X'.repeat(5000), phone_number: '+998901234567' },
      }),
    )!;
    expect(courierCardText(view).length).toBeLessThanOrEqual(4096);
    expect(formatSum('1000' as unknown)).toBe("1 000 so'm");
    expect(formatSum('1250000.50')).toBe("1 250 001 so'm");
    expect(formatSum(null)).toBe("0 so'm");
  });
});

describe('MO2MLPGo — 4 ta holat tugmasi', () => {
  const setup = (
    orders = [gatewayOrder('101', 'waiting')],
    op?: NonNullable<Parameters<typeof fakeOrdersGateway>[1]>['op'],
  ) => {
    const gateway = fakeOrdersGateway(orders, { op });
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    return { ctx, gateway };
  };
  const openList = (ctx: ReturnType<typeof makeRouter>) => openIshim(ctx);

  it('⭐ ✅ Sotildi → tasdiq → Ha → POST /orders/sell/:id, buyurtma SOLD, karta yangilanadi (Ortga)', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    expect(sentTexts(ctx).at(-1)).toBe(
      'Buyurtma #101 — ✅ Sotildi. Tasdiqlaysizmi?',
    );
    // Tasdiqsiz hech narsa yuborilmagan.
    expect(gateway.calls.some((call) => call.method === 'POST')).toBe(false);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    const post = gateway.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/orders/sell/101');
    expect(post.options).toEqual(
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(sentTexts(ctx).at(-1)).toBe('#101 — sotildi ✅');
    expect(gateway.orders.get('101')!.status).toBe('sold');
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      {
        text: string;
        reply_markup: { inline_keyboard: Array<Array<{ text: string }>> };
      },
    ];
    expect(edit[2].text).toContain('Sotildi');
    expect(
      edit[2].reply_markup.inline_keyboard.flat().map((b) => b.text),
    ).toEqual(['↩️ Ortga qaytarish']);
  });

  it('⭐ ✅ Ha ikki marta tez bosilsa — faqat BITTA holat o‘zgarishi', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const yes = lastButtons(ctx)['✅ Ha'];
    await press(ctx, yes);
    await press(ctx, yes);
    expect(
      gateway.calls.filter((call) => call.path === '/orders/sell/101'),
    ).toHaveLength(1);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_CONSUMED_TEXT,
    );
  });

  it('⭐ boshqa kuryer tugmani bossa (callback_data qo‘lda almashtirilsa) — rad, holat o‘zgarmaydi', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    const sell = lastButtons(ctx)['✅ Sotildi'];
    ctx.actors.resolve.mockResolvedValue(courierActor('26'));
    await press(ctx, sell, 26, 26);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_FOREIGN_TEXT,
    );
    expect(gateway.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('⭐ guruh chatidan kelgan holat callback’i rad etiladi', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    const sell = lastButtons(ctx)['✅ Sotildi'];
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate(sell, {
        chatId: -100555,
        fromId: 25,
        chatType: 'supergroup',
      }),
    );
    expect(sentTexts(ctx).at(-1)).toContain('faqat bot bilan SHAXSIY chatda');
    expect(gateway.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('⭐ SOLD buyurtmaga yana Sotildi — server rad etadi, odamga tushunarli xabar', async () => {
    const { ctx } = setup([gatewayOrder('101', 'waiting')], (op) =>
      op === 'sell'
        ? {
            status: 400,
            body: {
              message:
                'Buyurtma topilmadi yoki kutilmoqda (waiting) holatida emas',
            },
          }
        : undefined,
    );
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(sentTexts(ctx).at(-1)).toBe('⚠️ Bu holatda bu amal mumkin emas.');
  });

  it('⭐ extraCost > 0 — 202: "Market tasdig‘i kutilmoqda", karta ⏳ holatda tugmasiz qoladi', async () => {
    const { ctx } = setup([gatewayOrder('101', 'waiting')], (op) =>
      op === 'cancel'
        ? {
            status: 202,
            body: { statusCode: 202, message: "Market tasdig'i kutilmoqda" },
          }
        : undefined,
    );
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['❌ Bekor']);
    await press(ctx, lastButtons(ctx)['🙅 Mijoz rad etdi']);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(sentTexts(ctx).at(-1)).toContain("Market tasdig'i kutilmoqda");
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      { text: string; reply_markup: { inline_keyboard: unknown[] } },
    ];
    expect(edit[2].text).toContain('⏳');
    expect(edit[2].reply_markup.inline_keyboard).toEqual([]);
  });

  it('⭐ bekor sababi faqat yopiq ro‘yxatdan; gateway’ga enum qiymati ketadi', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['❌ Bekor']);
    expect(Object.keys(lastButtons(ctx))).toEqual([
      '📵 Mijoz javob bermadi',
      '🙅 Mijoz rad etdi',
      "📍 Manzil noto'g'ri",
      '🧩 Mahsulot nuqsonli',
      "💸 Narx bo'yicha kelishmovchilik",
      '⬅️ Orqaga',
    ]);
    await press(ctx, lastButtons(ctx)["📍 Manzil noto'g'ri"]);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    const post = gateway.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/orders/cancel/101');
    expect(post.body).toEqual({ reason: 'WRONG_ADDRESS' });
    // Erkin matn sabab sifatida qabul qilinmaydi (tasdiq kutilmaydi).
    ctx.outbox.send.mockClear();
    await ctx.router.dispatch(
      'elchi',
      textUpdate('mijoz kelmadi', { chatId: 25, updateId: 99 }),
    );
    expect(gateway.calls.filter((call) => call.method === 'POST')).toHaveLength(
      1,
    );
  });

  it('Yetkazib bo‘lmadi (ON_THE_ROAD) — sabab ≥10 belgi bilan could-not-deliver', async () => {
    const { ctx, gateway } = setup([gatewayOrder('102', 'on the road')]);
    await openList(ctx);
    await press(ctx, lastButtons(ctx)["🕗 Yetkazib bo'lmadi"]);
    await press(ctx, lastButtons(ctx)["🏠 Mijoz manzilda yo'q"]);
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    const post = gateway.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe('/orders/102/could-not-deliver');
    expect(
      String((post.body as { reason: string }).reason).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it('⬅️ Orqaga — amal bajarilmaydi', async () => {
    const { ctx, gateway } = setup();
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    await press(ctx, lastButtons(ctx)['⬅️ Orqaga']);
    expect(sentTexts(ctx).at(-1)).toBe('⬅️ Amal bekor qilindi.');
    expect(gateway.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('⭐ answerCallbackQuery ishdan OLDIN (sekin backend’da ham tugma osilmaydi)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({
      actor: courierActor(),
      gateway: jest.fn(async (...args: unknown[]) => {
        if ((args[1] as string) === 'POST') {
          order.push('post');
          await slow;
        }
        return (
          gateway.request as unknown as (...a: unknown[]) => Promise<unknown>
        )(...args);
      }),
    });
    ctx.transport.answerCallbackQuery.mockImplementation(() => {
      order.push('answer');
      return Promise.resolve();
    });
    await openList(ctx);
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const pending = press(ctx, lastButtons(ctx)['✅ Ha']);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await pending;
    expect(order.indexOf('answer')).toBeLessThan(order.indexOf('post'));
  });
});

it('callback nomlari 32 belgidan oshmaydi (telegram_bot_actions.action varchar(32))', () => {
  for (const name of Object.values(COURIER_ACTIONS)) {
    expect(name.length).toBeLessThanOrEqual(32);
  }
});
