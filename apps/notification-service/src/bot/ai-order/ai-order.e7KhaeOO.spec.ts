import { Logger } from '@nestjs/common';
import { CHAT_QUEUE_FULL_TEXT } from '../bot-router.service';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { AI_HINT_TEXT, AI_MEDIA_TEXT } from './ai-order.handler';
import {
  AI_ALREADY_CREATED_TEXT,
  AI_EXPIRED_TEXT,
  AI_NETWORK_TEXT,
  AI_WORKING_TEXT,
} from './ai-order.service';
import { isCreatable } from './ai-preview';

/**
 * e7KhaeOO — bot AI buyurtmaning faqat CHAQIRUVCHISI: matn/rasm →
 * `POST /orders/ai-parse` (operatorning o'z JWT'si) → preview →
 * ✅ Yaratish (`POST /orders/ai-confirm`) / ✏️ Tuzatish / ❌ Bekor.
 * Ekstraksiya botda YO'Q; qoralama DB'da (telegram_ai_drafts).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Ali Valiyev +998901234567 Andijon Asaka, Atir 50ml 2 ta, 150000';

const preview = (index: number, extra: Record<string, unknown> = {}) => ({
  index,
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
      quantity: 2,
      product_id: null,
      resolved_name: null,
      unresolved: true,
    },
  ],
  total_price: 150000,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: null,
  ...extra,
});

type GatewayCall = { tg: string; method: string; path: string; body: unknown };

function setup(
  options: {
    parse?: (call: GatewayCall) => Promise<{ status: number; body: unknown }>;
    confirm?: (call: GatewayCall) => Promise<{ status: number; body: unknown }>;
    actor?: Record<string, unknown> | null;
  } = {},
) {
  const calls: GatewayCall[] = [];
  const gateway = jest.fn(
    (tg: string, method: string, path: string, body: unknown) => {
      const call = { tg, method, path, body };
      calls.push(call);
      if (path === '/orders/ai-parse') {
        return (
          options.parse?.(call) ??
          Promise.resolve({
            status: 200,
            body: {
              data: {
                ok: true,
                draft_id: '11111111-2222-4333-8444-555555555555',
                orders: [
                  preview(0),
                  preview(1, {
                    district_id: null,
                    issues: ['district_missing'],
                  }),
                ],
              },
            },
          })
        );
      }
      if (path === '/orders/ai-confirm') {
        return (
          options.confirm?.(call) ??
          Promise.resolve({
            status: 200,
            body: {
              data: { results: [{ index: 0, ok: true, order_id: '81' }] },
            },
          })
        );
      }
      return Promise.resolve({ status: 404, body: null });
    },
  );
  const ctx = makeRouter({
    actor:
      options.actor === undefined
        ? {
            user_id: '40',
            role: 'market_operator',
            status: 'active',
            market_id: '37',
            region_id: null,
          }
        : (options.actor as never),
    gateway,
    aiOrder: true,
  });
  return { ctx, gateway, calls };
}

/** Oxirgi tugmali TAHRIR (preview "⏳" xabari ustiga yoziladi): matn → callback_data. */
const editButtons = (
  ctx: ReturnType<typeof makeRouter>,
): Record<string, string> => {
  const calls = ctx.transport.editMessage.mock.calls as unknown as Array<
    [
      string,
      string,
      {
        reply_markup?: {
          inline_keyboard: Array<
            Array<{ text: string; callback_data?: string }>
          >;
        };
      },
    ]
  >;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const rows = calls[i][2].reply_markup?.inline_keyboard ?? [];
    const buttons = rows.flat().filter((b) => b.callback_data);
    if (buttons.length) {
      return Object.fromEntries(buttons.map((b) => [b.text, b.callback_data!]));
    }
  }
  return {};
};

/** (BOT-3b) AI fonda — update tugagach ishchi ham tugashi kutiladi. */
const settle = async <T>(ctx: ReturnType<typeof makeRouter>, p: Promise<T>) => {
  const result = await p;
  await ctx.aiService?.idle();
  return result;
};
const send = (ctx: ReturnType<typeof makeRouter>, text: string, updateId = 1) =>
  settle(
    ctx,
    ctx.router.dispatch('elchi', textUpdate(text, { chatId: 40, updateId })),
  );
const press = (ctx: ReturnType<typeof makeRouter>, data: string) =>
  settle(
    ctx,
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: 40, fromId: 40 }),
    ),
  );

describe('e7KhaeOO — matn → AI preview (mavjud endpoint, operator JWT)', () => {
  it('⭐ market operatori matn tashlaydi → POST /orders/ai-parse (o‘z telegram id si), "⏳" xabari preview’ga aylanadi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    expect(calls.map((c) => [c.tg, c.method, c.path])).toEqual([
      ['40', 'POST', '/orders/ai-parse'],
    ]);
    const form = calls[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('text')).toBe(ORDER_TEXT);
    expect(form.get('market_id')).toBeNull();
    expect(sentTexts(ctx)[0]).toBe(AI_WORKING_TEXT);
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      { text: string },
    ];
    expect(edit[2].text).toContain('AI 2 ta buyurtma topdi');
    expect(edit[2].text).toContain('tuman aniqlanmadi');
    const [draft] = [...ctx.aiDrafts.rows.values()];
    expect(draft).toEqual(
      expect.objectContaining({
        status: 'preview',
        input: { text: ORDER_TEXT },
      }),
    );
  });

  it('⭐ "Yaratish" — faqat tayyor buyurtmalar; market_id YUBORILMAYDI (server user.market_id dan), draft_id + ai_item_index', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, editButtons(ctx)['✅ Yaratish']);
    const confirm = calls.find((c) => c.path === '/orders/ai-confirm')!;
    expect(confirm.tg).toBe('40');
    const body = confirm.body as {
      orders: Array<Record<string, unknown>>;
      market_id?: string;
    };
    expect(body).not.toHaveProperty('market_id');
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toEqual(
      expect.objectContaining({
        draft_id: '11111111-2222-4333-8444-555555555555',
        ai_item_index: 0,
        district_id: '12',
        items: [
          {
            product_name: 'Atir 50ml',
            allow_unlisted_product: true,
            quantity: 2,
          },
        ],
      }),
    );
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      { text: string },
    ];
    expect(edit[2].text).toContain('✅ 1) Buyurtma EL-100081 yaratildi');
    expect(edit[2].text).toContain('1 ta buyurtma kamchilik bilan');
  });

  it('⭐ "Yaratish" ikki marta (parallel) bosilsa — ai-confirm BIR marta, ikkinchisiga tushuntirish', async () => {
    let release: () => void = () => undefined;
    const { ctx, calls } = setup({
      confirm: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              body: {
                data: { results: [{ index: 0, ok: true, order_id: '81' }] },
              },
            });
        }),
    });
    await send(ctx, ORDER_TEXT);
    const button = editButtons(ctx)['✅ Yaratish'];
    const first = press(ctx, button);
    await new Promise((resolve) => setImmediate(resolve));
    const second = ctx.router.dispatch('elchi', {
      ...callbackUpdate(button, { chatId: 40, fromId: 40 }),
      update_id: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);
    expect(calls.filter((c) => c.path === '/orders/ai-confirm')).toHaveLength(
      1,
    );
    await press(ctx, button);
    expect(sentTexts(ctx).at(-1)).toBe(AI_ALREADY_CREATED_TEXT);
  });

  it('⭐ AI javob bermasa — tushunarli xato + "🔁 Qayta urinish", draft (matn) YO‘QOLMAYDI; qayta urinish → preview', async () => {
    let fail = true;
    const { ctx, calls } = setup({
      parse: () =>
        fail
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve({
              status: 200,
              body: {
                data: {
                  ok: true,
                  draft_id: '11111111-2222-4333-8444-555555555555',
                  orders: [preview(0)],
                },
              },
            }),
    });
    await send(ctx, ORDER_TEXT);
    const failed = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      { text: string },
    ];
    expect(failed[2].text).toBe(AI_NETWORK_TEXT);
    const [draft] = [...ctx.aiDrafts.rows.values()];
    expect(draft).toEqual(
      expect.objectContaining({
        status: 'failed',
        input: { text: ORDER_TEXT },
      }),
    );
    fail = false;
    await press(ctx, editButtons(ctx)['🔁 Qayta urinish']);
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(2);
    expect((calls[1].body as FormData).get('text')).toBe(ORDER_TEXT);
    expect(ctx.aiDrafts.rows.get(draft.id)?.status).toBe('preview');
  });

  it('server sababi (ok:false) — server matni; "disabled" — qayta urinish emas, kabinet', async () => {
    const { ctx } = setup({
      parse: () =>
        Promise.resolve({
          status: 200,
          body: {
            data: {
              ok: false,
              reason: 'disabled',
              message: 'AI hozir o‘chiq — qo‘lda kiriting',
            },
          },
        }),
    });
    await send(ctx, ORDER_TEXT);
    const edit = ctx.transport.editMessage.mock.calls.at(-1) as unknown as [
      string,
      string,
      {
        text: string;
        reply_markup: {
          inline_keyboard: Array<Array<{ text: string; url?: string }>>;
        };
      },
    ];
    expect(edit[2].text).toBe('❌ AI hozir o‘chiq — qo‘lda kiriting');
    expect(edit[2].reply_markup.inline_keyboard).toEqual([
      [
        {
          text: '🌐 Kabinetda yaratish',
          url: 'https://admin.elchi.test/orders/create',
        },
      ],
    ]);
  });

  it('⭐ bitta chatdan ketma-ket 3 rasm — tartib saqlanadi, har biri o‘z qoralamasi (ustma-ust yozilmaydi)', async () => {
    const { ctx, calls } = setup();
    for (const [i, fileId] of ['p1', 'p2', 'p3'].entries()) {
      await ctx.router.dispatch('elchi', {
        update_id: 10 + i,
        message: {
          message_id: 10 + i,
          chat: { id: 40, type: 'private' },
          from: { id: 40 },
          photo: [
            { file_id: fileId, file_size: 300_000, width: 800, height: 600 },
          ],
        },
      });
    }
    expect(
      ctx.transport.downloadFile.mock.calls.map(
        (call) => (call as unknown[])[0],
      ),
    ).toEqual(['p1', 'p2', 'p3']);
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(3);
    const drafts = [...ctx.aiDrafts.rows.values()];
    expect(
      drafts.map(
        (d) =>
          (d.input as { files: Array<{ file_id: string }> }).files[0].file_id,
      ),
    ).toEqual(['p1', 'p2', 'p3']);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(3);
  });

  it.each([
    [
      '2MB dan katta rasm (barcha o‘lchamlar)',
      { photo: [{ file_id: 'big', file_size: 3_000_000 }] },
    ],
    [
      'HEIC hujjat',
      {
        document: { file_id: 'h', mime_type: 'image/heic', file_size: 100_000 },
      },
    ],
    [
      // WHMAIqyo: WebP endi qabul qilinadi (gateway bilan bir xil) — GIF yo'q.
      'gif hujjat',
      {
        document: { file_id: 'g', mime_type: 'image/gif', file_size: 100_000 },
      },
    ],
    [
      '2MB dan katta PNG hujjat',
      {
        document: {
          file_id: 'p',
          mime_type: 'image/png',
          file_size: 2_500_000,
        },
      },
    ],
  ])(
    '⭐ %s → yo‘naltiruvchi xabar, AI CHAQIRILMAYDI',
    async (_label, media) => {
      const { ctx, gateway } = setup();
      await ctx.router.dispatch('elchi', {
        update_id: 20,
        message: {
          message_id: 20,
          chat: { id: 40, type: 'private' },
          from: { id: 40 },
          ...media,
        },
      });
      expect(sentTexts(ctx)).toEqual([AI_MEDIA_TEXT]);
      expect(gateway).not.toHaveBeenCalled();
      expect(ctx.transport.downloadFile).not.toHaveBeenCalled();
    },
  );

  it('reliz-9: 1,8 MB PNG hujjat (reliz-9 gacha o‘tardi) — qabul qilinadi, yuklash chegarasi 2 MB', async () => {
    const { ctx, calls } = setup();
    await ctx.router.dispatch('elchi', {
      update_id: 21,
      message: {
        message_id: 21,
        chat: { id: 40, type: 'private' },
        from: { id: 40 },
        document: {
          file_id: 'mid',
          mime_type: 'image/png',
          file_size: 1_800_000,
        },
      },
    });
    expect(sentTexts(ctx)).not.toContain(AI_MEDIA_TEXT);
    expect(ctx.transport.downloadFile.mock.calls).toEqual([
      ['mid', 2 * 1024 * 1024],
    ]);
    expect(calls.filter((c) => c.path === '/orders/ai-parse')).toHaveLength(1);
  });

  it('⭐ eskirgan (muddati o‘tgan) qoralama tugmasi — aniq "eskirgan" xabari, hech narsa yaratilmaydi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    const button = editButtons(ctx)['✅ Yaratish'];
    for (const row of ctx.aiDrafts.rows.values())
      row.expires_at = new Date(Date.now() - 1000);
    await press(ctx, button);
    expect(sentTexts(ctx).at(-1)).toBe(AI_EXPIRED_TEXT);
    expect(calls.filter((c) => c.path === '/orders/ai-confirm')).toHaveLength(
      0,
    );
  });

  it('restartdan keyin ham ishlaydi: tugmada faqat draft_id (holat DB’da, xotirada emas)', async () => {
    const { ctx } = setup();
    await send(ctx, ORDER_TEXT);
    const data = editButtons(ctx)['✅ Yaratish'];
    const lookup = await ctx.actions.lookup(data);
    expect(lookup).toEqual(
      expect.objectContaining({
        status: 'ok',
        action: expect.objectContaining({
          payload: { draft_id: [...ctx.aiDrafts.rows.keys()][0] },
        }),
      }),
    );
  });

  it('✏️ Tuzatish — preview yopiladi, kabinet havolasi; ❌ Bekor — hech narsa yaratilmaydi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, editButtons(ctx)['✏️ Tuzatish']);
    expect([...ctx.aiDrafts.rows.values()][0].status).toBe('cancelled');
    expect(calls.filter((c) => c.path === '/orders/ai-confirm')).toHaveLength(
      0,
    );
  });
});

describe('e7KhaeOO — kimga ishlaydi', () => {
  it('salomlashish (telefon raqami yo‘q) — AI chaqirilmaydi, yo‘riqnoma', async () => {
    const { ctx, gateway } = setup();
    await send(ctx, 'Assalomu alaykum');
    expect(sentTexts(ctx)).toEqual([AI_HINT_TEXT]);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('kuryer matni — AI emas', async () => {
    const { ctx, gateway } = setup({ actor: courierActor('25') });
    await send(ctx, ORDER_TEXT);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('bog‘lanmagan chat — AI emas (fail-closed)', async () => {
    const { ctx, gateway } = setup({ actor: null });
    await send(ctx, ORDER_TEXT);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('chat navbati to‘la (12) — "⏳ Juda ko‘p xabar navbatda"', async () => {
    const { ctx } = setup();
    Object.assign(ctx.router as object, {
      sequencer: { run: () => Promise.resolve('dropped') },
    });
    await send(ctx, ORDER_TEXT);
    expect(ctx.outbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '40', text: CHAT_QUEUE_FULL_TEXT }),
    );
  });

  it('isCreatable: tuman yo‘q / almashtirish — yo‘q; narxni tasdiqlash va katalogda yo‘q mahsulot — ha', () => {
    expect(
      isCreatable(
        preview(0, { issues: ['price_confirm', 'item_unresolved'] }) as never,
      ),
    ).toBe(true);
    expect(
      isCreatable(
        preview(0, {
          issues: ['district_missing'],
          district_id: null,
        }) as never,
      ),
    ).toBe(false);
    expect(isCreatable(preview(0, { is_replacement: true }) as never)).toBe(
      false,
    );
    expect(
      isCreatable(
        preview(0, { total_price: null, issues: ['price_missing'] }) as never,
      ),
    ).toBe(false);
  });
});
