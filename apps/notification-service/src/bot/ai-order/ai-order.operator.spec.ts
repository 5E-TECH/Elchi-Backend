import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_OPERATOR_PHONE_RETRY_TEXT,
  AI_OPERATOR_REJECTED_TEXT,
  AI_RETRY_ALL_HINT_TEXT,
  AI_RETRY_HINT_TEXT,
  userReason,
  validOperatorId,
} from './ai-order-operator';
import {
  AI_CANCELLED_PARTIAL_TEXT,
  AI_CANCELLED_TEXT,
  AI_EXPIRED_TEXT,
} from './ai-order.service';
import {
  AI_EDITS_NOT_APPLIED_TEXT,
  toConfirmOrder,
  type AiPreviewOrder,
} from './ai-preview';

/**
 * Bot AI preview: «🎧 Operator» tanlovi (faqat market) va operator raqami
 * (#715/#716 ai-confirm `operator_id` / `operator_phone`), qayta
 * urinishli natijalar. Barcha ma'lumot soxta.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Test Mijoz 90 000 00 01 Test tuman, Namuna atir 2 ta, 150000';
const DRAFT_ID = '11111111-2222-4333-8444-5555555555a7';
const PHONE_REQUIRED =
  'Operator telefon raqami majburiy. Market profilida doimiy operator raqamini kiriting yoki buyurtmada raqam yuboring (operator_phone)';
const PHONE_REQUIRED_SHOWN = userReason(PHONE_REQUIRED);

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

const operators = (n: number) => ({
  status: 200,
  body: {
    statusCode: 200,
    data: {
      items: Array.from({ length: n }, (_, k) => ({
        id: String(300 + k),
        name: `Operator ${String(k + 1).padStart(2, '0')}`,
      })),
    },
  },
});

type GatewayCall = { tg: string; method: string; path: string; body: unknown };
type Reply = { status: number; body: unknown } | Error;
type ConfirmBody = { orders: Array<Record<string, unknown>> };

const ok = (body: unknown): Reply => ({
  status: 200,
  body: {
    data: {
      results: (body as ConfirmBody).orders.map((_o, index) => ({
        index,
        ok: true,
        order_id: String(81 + index),
      })),
    },
  },
});

function setup(
  options: {
    role?: 'market' | 'market_operator';
    orders?: AiPreviewOrder[];
    selectable?: () => Reply;
    profile?: () => Reply;
    confirm?: Array<(body: unknown) => Reply>;
  } = {},
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
          body: {
            data: {
              ok: true,
              draft_id: DRAFT_ID,
              orders: options.orders ?? [preview()],
            },
          },
        };
      } else if (path === '/orders/ai-confirm') {
        reply = (confirm.shift() ?? ok)(body);
      } else if (path === '/market-operators/selectable') {
        reply = options.selectable?.() ?? operators(2);
      } else if (path === '/auth/my-profile') {
        reply = options.profile?.() ?? {
          status: 200,
          body: {
            data: {
              phone_number: '+998900000099',
              require_operator_phone: false,
              default_operator_phone: null,
            },
          },
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
      role: options.role ?? 'market',
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
const lastShown = (ctx: Ctx) => shownTexts(ctx).at(-1) ?? '';
const confirms = (calls: GatewayCall[]) =>
  calls.filter((c) => c.path === '/orders/ai-confirm');
const sentOrder = (calls: GatewayCall[], n = 0) =>
  (confirms(calls)[n].body as ConfirmBody).orders[0];
const payloadOf = (ctx: Ctx, data: string) =>
  [...ctx.actions.rows.values()].find((r) => `a:${r.action_id}` === data)!
    .payload;

describe('«🎧 Operator» tanlovi', () => {
  it('⭐ market: ro‘yxat (selectable, aktor JWT) → tanlash → ai-confirm operator_id', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    expect(
      calls.filter((c) => c.path === '/market-operators/selectable'),
    ).toEqual([
      expect.objectContaining({
        tg: '40',
        method: 'GET',
        path: '/market-operators/selectable',
      }),
    ]);
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '🎧 Operator: tanlanmagan',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    expect(Object.keys(picker)).toEqual([
      'Operator 01',
      'Operator 02',
      '🚫 Tanlamaslik',
      '↩️ Orqaga',
    ]);
    // Payload — faqat o'rin va id (ism yo'q).
    expect(payloadOf(ctx, picker['Operator 02'])).toEqual({
      k: 1,
      oid: '301',
      draft_id: row(ctx).id,
    });
    await press(ctx, picker['Operator 02']);
    expect(row(ctx).input.meta).toEqual(
      expect.objectContaining({
        operator_id: '301',
        operator_name: 'Operator 02',
      }),
    );
    expect(Object.keys(buttons(ctx))).toContain('🎧 Operator: Operator 02');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls).operator_id).toBe('301');
  });

  it('«🚫 Tanlamaslik» — operator_id yuborilmaydi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 01']);
    await press(ctx, buttons(ctx)['🎧 Operator: Operator 01']);
    await press(ctx, buttons(ctx)['🚫 Tanlamaslik']);
    expect(Object.keys(buttons(ctx))).toContain('🎧 Operator: tanlanmagan');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_id');
  });

  it('market operatori: ro‘yxat so‘ralmaydi, tugma yo‘q, operator_id hech qachon yuborilmaydi', async () => {
    const { ctx, calls } = setup({ role: 'market_operator' });
    await send(ctx, ORDER_TEXT);
    expect(calls.map((c) => c.path)).toEqual(['/orders/ai-parse']);
    expect(Object.keys(buttons(ctx)).some((k) => k.startsWith('🎧'))).toBe(
      false,
    );
    // Qoralamaga qo'lda yozilgan tanlov ham (rol market emas) yuborilmaydi.
    row(ctx).input.meta.operator_id = '301';
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_id');
    expect(sentOrder(calls)).not.toHaveProperty('operator_phone');
  });

  it('eski tugma (ro‘yxat almashgan) boshqa operatorni qo‘ymaydi — oyna qayta', async () => {
    const { ctx } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const old = buttons(ctx);
    row(ctx).input.meta.operators = [
      { id: '305', name: 'Operator Yangi' },
      { id: '300', name: 'Operator 01' },
    ];
    await press(ctx, old['Operator 01']);
    expect(row(ctx).input.meta.operator_id).toBeUndefined();
    expect(Object.keys(buttons(ctx))).toContain('Operator Yangi');
  });

  it('25 ta operator — 20 ta tugma va «… yana 5 ta»', async () => {
    const { ctx } = setup({ selectable: () => operators(25) });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    expect(
      Object.keys(buttons(ctx)).filter((k) => k.startsWith('Operator ')),
    ).toHaveLength(20);
    expect(lastShown(ctx)).toContain('… yana 5 ta');
  });

  it.each([
    ['500', (): Reply => ({ status: 500, body: null })],
    ['tarmoq xatosi', (): Reply => new Error('ECONNRESET')],
    ['bo‘sh ro‘yxat', (): Reply => operators(0)],
  ])('selectable %s — tugma yo‘q, preview baribir', async (_n, selectable) => {
    const { ctx } = setup({ selectable });
    await send(ctx, ORDER_TEXT);
    expect(row(ctx).status).toBe('preview');
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
  });

  it('natijasi noma‘lum urinishdan keyin operator o‘zgartirilmaydi', async () => {
    const { ctx } = setup({ confirm: [() => new Error('timeout')] });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    await press(ctx, picker['↩️ Orqaga']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(Object.keys(buttons(ctx)).some((k) => k.startsWith('🎧'))).toBe(
      false,
    );
    await press(ctx, picker['Operator 02']);
    expect(row(ctx).input.meta.operator_id).toBeUndefined();
  });
});

describe('operator raqami (operator_phone)', () => {
  const profile =
    (data: Record<string, unknown>): (() => Reply) =>
    () => ({ status: 200, body: { data } });

  it('⭐ market: raqam majburiy, doimiy raqam yo‘q — marketning profil raqami yuboriladi', async () => {
    const { ctx, calls } = setup({
      profile: profile({
        phone_number: '90 000 00 99',
        require_operator_phone: true,
        default_operator_phone: null,
      }),
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls).operator_phone).toBe('+998900000099');
    expect(row(ctx).status).toBe('created');
  });

  it.each([
    [
      'majburiy emas',
      { phone_number: '+998900000099', require_operator_phone: false },
    ],
    [
      'majburiy, lekin doimiy raqam bor',
      {
        phone_number: '+998900000099',
        require_operator_phone: true,
        default_operator_phone: '+998900000088',
      },
    ],
    ['profil raqami yo‘q', { phone_number: '', require_operator_phone: true }],
  ])('market: %s — operator_phone yuborilmaydi', async (_n, data) => {
    const { ctx, calls } = setup({ profile: profile(data) });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_phone');
  });

  it('S3: market — profil so‘rovi vaqtincha yiqildi, server «majburiy» dedi → bir marta qayta; ikkinchi «✅» profil raqami bilan', async () => {
    let profileCalls = 0;
    const { ctx, calls } = setup({
      profile: () =>
        (profileCalls += 1) === 1
          ? { status: 500, body: null }
          : {
              status: 200,
              body: {
                data: {
                  phone_number: '+998900000099',
                  require_operator_phone: false,
                },
              },
            },
      confirm: [
        () => ({
          status: 200,
          body: {
            data: {
              results: [
                {
                  index: 0,
                  ok: false,
                  code: 'create_failed',
                  reason: PHONE_REQUIRED,
                },
              ],
            },
          },
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_phone');
    // Foydalanuvchiga API maydon nomi («(operator_phone)») ko'rinmaydi.
    expect(lastShown(ctx)).toContain(`❌ 1) ${PHONE_REQUIRED_SHOWN}`);
    expect(lastShown(ctx)).not.toContain('(operator_phone)');
    expect(lastShown(ctx)).toContain(AI_RETRY_ALL_HINT_TEXT);
    expect(row(ctx).status).toBe('preview');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls, 1).operator_phone).toBe('+998900000099');
    expect(row(ctx).status).toBe('created');
  });

  it('market: profil raqami qoralama bo‘yicha keshlanadi (har «✅» da so‘ralmaydi)', async () => {
    const { ctx, calls } = setup({
      confirm: [
        () => ({
          status: 200,
          body: {
            data: {
              results: [
                {
                  index: 0,
                  ok: false,
                  code: 'validation_unavailable',
                  reason: 'tekshirib bo‘lmadi',
                },
              ],
            },
          },
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/auth/my-profile')).toHaveLength(1);
  });

  it('⭐ market operatori: server «majburiy» dedi → qayta urinish mumkin; qayta «✅» o‘z profil raqami bilan', async () => {
    const { ctx, calls } = setup({
      role: 'market_operator',
      confirm: [
        () => ({
          status: 200,
          body: {
            data: {
              results: [
                {
                  index: 0,
                  ok: false,
                  code: 'create_failed',
                  reason: PHONE_REQUIRED,
                },
              ],
            },
          },
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(calls.filter((c) => c.path === '/auth/my-profile')).toEqual([]);
    expect(sentOrder(calls)).not.toHaveProperty('operator_phone');
    expect(row(ctx).status).toBe('preview');
    expect(row(ctx).input.meta.operator_phone_needed).toBe(true);
    expect(lastShown(ctx)).toContain(PHONE_REQUIRED_SHOWN);
    expect(lastShown(ctx)).toContain(AI_OPERATOR_PHONE_RETRY_TEXT);
    // Hammasi yaratilmagan — «ba'zi» emas.
    expect(lastShown(ctx)).toContain(AI_RETRY_ALL_HINT_TEXT);

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(calls.filter((c) => c.path === '/auth/my-profile')).toHaveLength(1);
    expect(sentOrder(calls, 1).operator_phone).toBe('+998900000099');
    expect(row(ctx).status).toBe('created');
  });
});

describe('natija xatolari', () => {
  it('operatorga oid bo‘lmagan create_failed — server sababi, qayta urinish yo‘q', async () => {
    const reason = 'Mahsulot topilmadi';
    const { ctx } = setup({
      confirm: [
        () => ({
          status: 200,
          body: {
            data: {
              results: [{ index: 0, ok: false, code: 'create_failed', reason }],
            },
          },
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 01']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(lastShown(ctx)).toContain(`❌ 1) ${reason}`);
    expect(lastShown(ctx)).not.toContain(AI_RETRY_HINT_TEXT);
  });

  it('⭐ validation_unavailable — qayta urinish mumkin: preview, belgi, «✅» qayta yuboradi', async () => {
    const reason =
      'Operatorni tekshirib bo‘lmadi — birozdan so‘ng qayta yuboring';
    const { ctx, calls } = setup({
      orders: [preview(), preview({ index: 1, customer_name: 'Ikkinchi' })],
      confirm: [
        () => ({
          status: 200,
          body: {
            data: {
              results: [
                { index: 0, ok: true, order_id: '81' },
                {
                  index: 1,
                  ok: false,
                  code: 'validation_unavailable',
                  reason,
                },
              ],
            },
          },
        }),
        () => ({
          status: 200,
          body: {
            data: {
              results: [
                { index: 0, ok: true, order_id: '81', idempotent_replay: true },
                { index: 1, ok: true, order_id: '82' },
              ],
            },
          },
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(lastShown(ctx)).toContain('✅ 1) Buyurtma');
    expect(lastShown(ctx)).toContain(`❌ 2) ${reason}`);
    expect(lastShown(ctx)).toContain(AI_RETRY_HINT_TEXT);
    // S6: faqat YARATILGANI belgilanadi («✅ Yaratilgan», «Javob kelmadi»
    // emas); yaratilmagani belgisiz — tuzatsa bo'ladi.
    expect(row(ctx).orders[0]).toEqual(
      expect.objectContaining({ confirm_order_id: '81' }),
    );
    expect(row(ctx).orders[1].confirm_attempted_at).toBeUndefined();
    expect(lastShown(ctx)).not.toContain('Javob kelmadi');
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '🎧 Operator: tanlanmagan',
      '✏️ Tuzatish',
      '❌ Bekor',
      '🌐 Kabinetda yaratish',
    ]);
    // Karta: 1-buyurtma «✅ Yaratilgan», ✏️ — darhol 2-buyurtma menyusi.
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(lastShown(ctx)).toContain('2-buyurtma</b> — nimani tuzatamiz?');
    await press(ctx, buttons(ctx)['↩️ Orqaga']);
    expect(lastShown(ctx)).toContain('✅ Yaratilgan: EL-100081');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(2);
    expect(row(ctx).status).toBe('created');
    expect(lastShown(ctx)).toContain('avval yaratilgan');
  });
});

describe('#721 review', () => {
  type ResultRow = Record<string, unknown>;
  const results =
    (...rows: ResultRow[]) =>
    (): Reply => ({ status: 200, body: { data: { results: rows } } });
  const two = () => [
    preview(),
    preview({
      index: 1,
      customer_name: 'Ikkinchi',
      phone_number: '+998900000002',
    }),
  ];

  it('⭐ B1: qisman yaratilgandan keyin «❌ Bekor» — «hech narsa yaratilmadi» EMAS, yaratilgani ro‘yxatda', async () => {
    const { ctx } = setup({
      orders: two(),
      confirm: [
        results(
          { index: 0, ok: true, order_id: '81' },
          {
            index: 1,
            ok: false,
            code: 'validation_unavailable',
            reason: 'tekshirib bo‘lmadi',
          },
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['❌ Bekor']);
    expect(row(ctx).status).toBe('cancelled');
    expect(lastShown(ctx)).not.toContain(AI_CANCELLED_TEXT);
    expect(lastShown(ctx)).toContain(AI_CANCELLED_PARTIAL_TEXT);
    expect(lastShown(ctx)).toContain('✅ 1) Buyurtma EL-100081 yaratilgan');
    expect(Object.keys(buttons(ctx))).toEqual(['🌐 Kabinetda yaratish']);
  });

  it('B1: natijasi noma‘lum urinishdan keyin «❌ Bekor» ham ogohlantiradi', async () => {
    const { ctx } = setup({ confirm: [() => new Error('timeout')] });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['❌ Bekor']);
    expect(lastShown(ctx)).toContain(AI_CANCELLED_PARTIAL_TEXT);
    expect(lastShown(ctx)).not.toContain(AI_CANCELLED_TEXT);
  });

  it('S1: operator tanlovi izga kiradi — yaratilgandan keyin almashtirilsa takroriy javobda «qo‘llanmadi»', async () => {
    const { ctx } = setup({
      orders: two(),
      confirm: [
        results(
          { index: 0, ok: true, order_id: '81' },
          {
            index: 1,
            ok: false,
            code: 'validation_unavailable',
            reason: 'tekshirib bo‘lmadi',
          },
        ),
        results(
          { index: 0, ok: true, order_id: '81', idempotent_replay: true },
          { index: 1, ok: true, order_id: '82' },
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 01']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['🎧 Operator: Operator 01']);
    await press(ctx, buttons(ctx)['Operator 02']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    // Bitta «⚠️» (avval «⚠️ 1) ⚠️ …» edi).
    expect(lastShown(ctx)).toContain(
      AI_EDITS_NOT_APPLIED_TEXT.replace(/^⚠️ /, '⚠️ 1) '),
    );
    expect(lastShown(ctx)).not.toContain('⚠️ 1) ⚠️');
    expect(lastShown(ctx)).not.toContain("⚠️ 2) Tuzatishlar qo'llanmadi");
  });

  it('S1: tanlov o‘qilgandan keyin noma‘lum natija belgisi paydo bo‘lsa — yozilmaydi, joriy karta (eskirgan EMAS)', async () => {
    const { ctx } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    // Orada «✅» → timeout → noma'lum natija belgisi (o'qishdan KEYIN).
    const original = ctx.aiDrafts.findOne.getMockImplementation()!;
    ctx.aiDrafts.findOne.mockImplementationOnce((args) =>
      original(args).then((draft) => {
        row(ctx).orders[0] = {
          ...row(ctx).orders[0],
          confirm_attempted_at: Date.now(),
        };
        return draft;
      }),
    );
    await press(ctx, picker['Operator 02']);
    expect(row(ctx).input.meta.operator_id).toBeUndefined();
    expect(shownTexts(ctx)).not.toContain(AI_EXPIRED_TEXT);
    expect(lastShown(ctx)).toContain('Javob kelmadi');
  });

  it('S1: SQL now() bilan yozilgan qoralamada ham tanlov yoziladi (vaqt tengligi shart emas)', async () => {
    const { ctx } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    const original = ctx.aiDrafts.findOne.getMockImplementation()!;
    ctx.aiDrafts.findOne.mockImplementationOnce((args) =>
      original(args).then((draft) => {
        // Mikrosekundli now() — JS Date bilan teng chiqmaydigan qiymat.
        row(ctx).updated_at = new Date(Date.now() + 1);
        return draft;
      }),
    );
    await press(ctx, picker['Operator 02']);
    expect(row(ctx).input.meta.operator_id).toBe('301');
  });

  it('⭐ S2: tanlangan operator rad etildi — qayta urinishli: tanlov olib tashlanadi, ro‘yxat yangilanadi', async () => {
    let lists = 0;
    const { ctx, calls } = setup({
      selectable: () => ((lists += 1) === 1 ? operators(2) : operators(1)),
      confirm: [
        results({
          index: 0,
          ok: false,
          code: 'create_failed',
          reason: 'Tanlangan operator bu marketga tegishli emas yoki faol emas',
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 02']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(row(ctx).orders[0].confirm_attempted_at).toBeUndefined();
    expect(row(ctx).input.meta.operator_id).toBeUndefined();
    expect(row(ctx).input.meta.operators).toEqual([
      { id: '300', name: 'Operator 01' },
    ]);
    expect(lastShown(ctx)).toContain(AI_OPERATOR_REJECTED_TEXT);
    expect(Object.keys(buttons(ctx))).toContain('🎧 Operator: tanlanmagan');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls, 1)).not.toHaveProperty('operator_id');
    expect(row(ctx).status).toBe('created');
  });

  it('S4: not_started — qayta urinishli', async () => {
    const { ctx } = setup({
      confirm: [
        results({
          index: 0,
          ok: false,
          code: 'not_started',
          reason: 'Vaqt yetmadi — bu buyurtma yaratilmadi, uni qayta yuboring',
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(lastShown(ctx)).toContain(AI_RETRY_ALL_HINT_TEXT);
  });

  it('S5: operator id shartnomasi — ^[1-9]\\d{0,18}$ va ≤ INT8_MAX', () => {
    expect(validOperatorId('0')).toBeNull();
    expect(validOperatorId('007')).toBeNull();
    expect(validOperatorId('9223372036854775808')).toBeNull();
    expect(validOperatorId('9223372036854775807')).toBe('9223372036854775807');
    expect(validOperatorId('301')).toBe('301');
    expect(
      toConfirmOrder(preview(), null, { operator_id: '007' }),
    ).not.toHaveProperty('operator_id');
  });

  it('⭐ S7a: egasi tanlamagan, preview ifloslangan — himoyalangan maydon yuborilmaydi', async () => {
    const polluted = {
      ...preview(),
      operator_id: '301',
      customer_id: '120',
      operator_phone: '+998900000077',
      verified_operator_id: '301',
      market_id: '77',
      items: [
        {
          name: 'Namuna atir',
          quantity: 2,
          product_id: '15',
          operator_id: '301',
        },
      ],
    } as unknown as AiPreviewOrder;
    const { ctx, calls } = setup({ orders: [polluted] });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const body = JSON.stringify(confirms(calls)[0].body);
    for (const key of [
      'operator_id',
      'customer_id',
      'operator_phone',
      'verified_operator_id',
      'market_id',
    ]) {
      expect(body).not.toContain(`"${key}"`);
    }
  });

  it.each([
    ['begona oid', { k: 0, oid: '999' }],
    ['k satr', { k: '0', oid: '300' }],
    ['k chegaradan tashqari', { k: 5, oid: '300' }],
  ])('S7b: soxta ai.opick (%s) — e’tiborsiz', async (_n, payload) => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    const data = await ctx.actions.create({
      chatId: '40',
      action: 'ai.opick',
      actorUserId: '40',
      payload: { ...payload, draft_id: row(ctx).id },
      oneShot: false,
    });
    await press(ctx, data);
    expect(row(ctx).input.meta.operator_id).toBeUndefined();
    // Tanlov yozilmadi — joriy ro'yxat qayta ko'rsatildi.
    expect(Object.keys(buttons(ctx))).toContain('🚫 Tanlamaslik');
    await press(ctx, buttons(ctx)['↩️ Orqaga']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_id');
  });

  it('rol «✅» paytida qayta o‘qiladi — market operatoriga aylangan aktor operator_id yubormaydi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 01']);
    ctx.actors.resolve.mockResolvedValue({
      user_id: '40',
      role: 'market_operator',
      status: 'active',
      market_id: '40',
      region_id: null,
    });
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_id');
  });
});

describe('BLOCKER: qayta urinishli partiyada natijasi NOMA‘LUM buyurtma qulflanadi', () => {
  const batch =
    (...rows: Array<Record<string, unknown>>) =>
    (): Reply => ({ status: 200, body: { data: { results: rows } } });
  const orders = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      preview({
        index: i,
        customer_name: i ? `Mijoz ${i + 1}` : 'Test Mijoz',
        phone_number: `+99890000000${i + 1}`,
      }),
    );

  it('⭐ [timeout_unknown, not_started] — 1-buyurtma qulflangan («Javob kelmadi»), 🎧 yopiq, ✏️ faqat 2-si; «❌» ikki marta ham ogohlantiradi', async () => {
    const { ctx } = setup({
      orders: orders(2),
      confirm: [
        batch(
          {
            index: 0,
            ok: false,
            code: 'timeout_unknown',
            reason: 'Natija noma’lum',
          },
          {
            index: 1,
            ok: false,
            code: 'not_started',
            reason: 'Vaqt yetmadi',
          },
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    const card = buttons(ctx);
    await press(ctx, card['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(row(ctx).orders[0].confirm_order_id).toBeUndefined();
    expect(row(ctx).orders[1].confirm_attempted_at).toBeUndefined();
    expect(lastShown(ctx)).toContain(AI_RETRY_HINT_TEXT);
    expect(lastShown(ctx)).not.toContain(AI_RETRY_ALL_HINT_TEXT);
    const keys = Object.keys(buttons(ctx));
    expect(keys.some((k) => k.startsWith('🎧'))).toBe(false);
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(lastShown(ctx)).toContain('2-buyurtma</b> — nimani tuzatamiz?');
    // Eski kartaning 🎧 tugmasi — tanlov yo'q.
    await press(ctx, card['🎧 Operator: tanlanmagan']);
    expect(Object.keys(buttons(ctx)).some((k) => k === 'Operator 01')).toBe(
      false,
    );
    await press(ctx, buttons(ctx)['❌ Bekor']);
    expect(lastShown(ctx)).toContain(AI_CANCELLED_PARTIAL_TEXT);
    await press(ctx, card['❌ Bekor']);
    expect(lastShown(ctx)).toContain(AI_CANCELLED_PARTIAL_TEXT);
    expect(shownTexts(ctx)).not.toContain(AI_CANCELLED_TEXT);
  });

  it('⭐ [ok, duplicate_in_progress, validation_unavailable] — 1 yaratilgan, 2 noma‘lum (qulf), 3 belgisiz', async () => {
    const { ctx } = setup({
      orders: orders(3),
      confirm: [
        batch(
          { index: 0, ok: true, order_id: '81' },
          {
            index: 1,
            ok: false,
            code: 'duplicate_in_progress',
            reason: 'Xuddi shu buyurtma hozir yaratilmoqda',
          },
          {
            index: 2,
            ok: false,
            code: 'validation_unavailable',
            reason: 'tekshirib bo‘lmadi',
          },
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    const [first, second, third] = row(ctx).orders as AiPreviewOrder[];
    expect(first.confirm_order_id).toBe('81');
    expect(typeof second.confirm_attempted_at).toBe('number');
    expect(second.confirm_order_id).toBeUndefined();
    expect(third.confirm_attempted_at).toBeUndefined();
    expect(lastShown(ctx)).toContain(
      '❌ 2) Xuddi shu buyurtma hozir yaratilmoqda',
    );
    await press(ctx, buttons(ctx)['✏️ Tuzatish']);
    expect(lastShown(ctx)).toContain('3-buyurtma</b> — nimani tuzatamiz?');
  });

  it('natija yo‘q (server kamroq natija qaytardi) — noma‘lum, qulf', async () => {
    const { ctx } = setup({
      orders: orders(2),
      confirm: [
        batch({
          index: 1,
          ok: false,
          code: 'not_started',
          reason: 'Vaqt yetmadi',
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(row(ctx).orders[1].confirm_attempted_at).toBeUndefined();
  });

  it.each([
    [
      'reason_code (#722)',
      {
        reason: 'Operator mos emas',
        reason_code: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
      },
    ],
    [
      'matn zaxirasi (eski gateway)',
      { reason: 'Tanlangan operator bu marketga tegishli emas yoki faol emas' },
    ],
  ])(
    'operator rad etildi (%s) + noma‘lum natija — 1-si qulf, matn «🎧 Operator» ni taklif qilmaydi',
    async (_n, rejection) => {
      const { ctx } = setup({
        orders: orders(2),
        confirm: [
          batch(
            {
              index: 0,
              ok: false,
              code: 'timeout_unknown',
              reason: 'Natija noma’lum',
            },
            { index: 1, ok: false, code: 'create_failed', ...rejection },
          ),
        ],
      });
      await send(ctx, ORDER_TEXT);
      await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
      await press(ctx, buttons(ctx)['Operator 01']);
      await press(ctx, buttons(ctx)['✅ Yaratish']);
      expect(row(ctx).status).toBe('preview');
      expect(row(ctx).input.meta.operator_id).toBeUndefined();
      expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
      expect(row(ctx).orders[1].confirm_attempted_at).toBeUndefined();
      expect(lastShown(ctx)).not.toContain(AI_OPERATOR_REJECTED_TEXT);
      expect(lastShown(ctx)).toContain('operatorsiz yuboradi');
    },
  );

  it('noma‘lum reason_code + NOT_CREATED kodi — ANIQ yaratilmagan (belgisiz); timeout_unknown / duplicate_in_progress / natija yo‘q — noma‘lum', async () => {
    const { ctx } = setup({
      orders: orders(5),
      confirm: [
        batch(
          {
            index: 0,
            ok: false,
            code: 'create_failed',
            reason: 'Yangi sabab',
            reason_code: 'SOMETHING_NEW',
          },
          {
            index: 1,
            ok: false,
            code: 'not_started',
            reason: 'Vaqt yetmadi',
            reason_code: 'SOMETHING_NEW',
          },
          {
            index: 2,
            ok: false,
            code: 'timeout_unknown',
            reason: 'Natija noma’lum',
            reason_code: 'SOMETHING_NEW',
          },
          {
            index: 3,
            ok: false,
            code: 'duplicate_in_progress',
            reason: 'Yaratilmoqda',
          },
          // index 4 — natija yo'q.
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    const marked = (row(ctx).orders as AiPreviewOrder[]).map(
      (o) => typeof o.confirm_attempted_at === 'number',
    );
    expect(marked).toEqual([false, false, true, true, true]);
    expect(lastShown(ctx)).toContain('❌ 1) Yangi sabab');
  });

  it('nit: profil raqami normallashmasa keshlanmaydi; userReason oddiy qavsdagi so‘zni qoldiradi', async () => {
    const { ctx, calls } = setup({
      profile: () => ({
        status: 200,
        body: { data: { phone_number: 'abc', require_operator_phone: true } },
      }),
      confirm: [
        batch({
          index: 0,
          ok: false,
          code: 'validation_unavailable',
          reason: 'x',
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(calls.filter((c) => c.path === '/auth/my-profile')).toHaveLength(2);
    expect(userReason('Tuman (viloyat) topilmadi (district_id)')).toBe(
      'Tuman (viloyat) topilmadi',
    );
  });

  it('nit: qisman yaratilgandan keyin tanlash oynasi «hali yaratilmagan buyurtmalarga» deydi', async () => {
    const { ctx } = setup({
      orders: orders(2),
      confirm: [
        batch(
          { index: 0, ok: true, order_id: '81' },
          {
            index: 1,
            ok: false,
            code: 'validation_unavailable',
            reason: 'x',
          },
        ),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    expect(lastShown(ctx)).toContain('hali yaratilmagan buyurtmalarga');
  });
});

describe('#722 reason_code — natija sababi kod bo‘yicha (matn faqat zaxira)', () => {
  const failed = (reason: string, reasonCode?: string) => (): Reply => ({
    status: 200,
    body: {
      data: {
        results: [
          {
            index: 0,
            ok: false,
            code: 'create_failed',
            reason,
            ...(reasonCode ? { reason_code: reasonCode } : {}),
          },
        ],
      },
    },
  });

  it('⭐ OPERATOR_PHONE_REQUIRED (matn boshqacha) — qayta urinishli, keyingi «✅» profil raqami bilan', async () => {
    const { ctx, calls } = setup({
      role: 'market_operator',
      confirm: [failed('Raqam kerak', 'OPERATOR_PHONE_REQUIRED')],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(row(ctx).input.meta.operator_phone_needed).toBe(true);
    expect(lastShown(ctx)).toContain(AI_OPERATOR_PHONE_RETRY_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls, 1).operator_phone).toBe('+998900000099');
  });

  it.each([
    ['CHOSEN_OPERATOR_NOT_SELECTABLE', 'Operator mos emas'],
    ['CHOSEN_OPERATOR_SELF_ONLY', 'Faqat o‘zingizni tanlay olasiz'],
  ])(
    '⭐ %s — tanlov olib tashlanadi, ro‘yxat yangilanadi, qayta urinishli',
    async (reasonCode, reason) => {
      let lists = 0;
      const { ctx, calls } = setup({
        selectable: () => ((lists += 1) === 1 ? operators(2) : operators(1)),
        confirm: [failed(reason, reasonCode)],
      });
      await send(ctx, ORDER_TEXT);
      await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
      await press(ctx, buttons(ctx)['Operator 02']);
      await press(ctx, buttons(ctx)['✅ Yaratish']);
      expect(row(ctx).status).toBe('preview');
      expect(row(ctx).input.meta.operator_id).toBeUndefined();
      expect(
        calls.filter((c) => c.path === '/market-operators/selectable'),
      ).toHaveLength(2);
      expect(lastShown(ctx)).toContain(AI_OPERATOR_REJECTED_TEXT);
    },
  );

  it('noma‘lum reason_code — matn mos kelsa ham umumiy xato (qayta urinish yo‘q)', async () => {
    const { ctx } = setup({
      role: 'market_operator',
      confirm: [failed(PHONE_REQUIRED, 'SOMETHING_NEW')],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(lastShown(ctx)).toContain(`❌ 1) ${PHONE_REQUIRED_SHOWN}`);
    expect(lastShown(ctx)).not.toContain(AI_RETRY_ALL_HINT_TEXT);
  });

  it('operator rad etildi (reason_code), lekin tanlov yuborilmagan — umumiy xato (qayta urinish ma’nosiz)', async () => {
    const { ctx } = setup({
      confirm: [failed('Operator mos emas', 'CHOSEN_OPERATOR_SELF_ONLY')],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('created');
    expect(lastShown(ctx)).toContain('❌ 1) Operator mos emas');
  });

  it('zaxira: reason_code yo‘q (eski gateway) — matn bo‘yicha (raqam va operator)', async () => {
    const phone = setup({
      role: 'market_operator',
      confirm: [failed(PHONE_REQUIRED)],
    });
    await send(phone.ctx, ORDER_TEXT);
    await press(phone.ctx, buttons(phone.ctx)['✅ Yaratish']);
    expect(row(phone.ctx).input.meta.operator_phone_needed).toBe(true);

    const op = setup({
      confirm: [
        failed('Tanlangan operator bu marketga tegishli emas yoki faol emas'),
      ],
    });
    await send(op.ctx, ORDER_TEXT);
    await press(op.ctx, buttons(op.ctx)['🎧 Operator: tanlanmagan']);
    await press(op.ctx, buttons(op.ctx)['Operator 01']);
    await press(op.ctx, buttons(op.ctx)['✅ Yaratish']);
    expect(row(op.ctx).status).toBe('preview');
    expect(row(op.ctx).input.meta.operator_id).toBeUndefined();
  });
});

describe('#724 follow-up — matnlar butun qoralama bo‘yicha; VU matni rad etish emas', () => {
  const batch =
    (...rows: Array<Record<string, unknown>>) =>
    (): Reply => ({ status: 200, body: { data: { results: rows } } });
  const notStarted = (index: number) => ({
    index,
    ok: false,
    code: 'not_started',
    reason: 'Vaqt yetmadi',
  });
  const two = () => [
    preview(),
    preview({
      index: 1,
      customer_name: 'Ikkinchi',
      phone_number: '+998900000002',
    }),
  ];

  it('⭐ H1: timeout → qayta [not_started, not_started] — ikkalasi qulf, ko‘rsatma «Buyurtmalar yaratilmadi» EMAS', async () => {
    const { ctx } = setup({
      orders: two(),
      confirm: [
        () => new Error('timeout'),
        batch(notStarted(0), notStarted(1)),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(
      (row(ctx).orders as AiPreviewOrder[]).every(
        (o) => typeof o.confirm_attempted_at === 'number',
      ),
    ).toBe(true);
    expect(lastShown(ctx)).toContain(AI_RETRY_HINT_TEXT);
    expect(lastShown(ctx)).not.toContain(AI_RETRY_ALL_HINT_TEXT);
  });

  it.each([
    [
      'matn',
      {
        reason: 'Tanlangan operator bu marketga tegishli emas yoki faol emas',
      },
    ],
    [
      'reason_code',
      {
        reason: 'Operator mos emas',
        reason_code: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
      },
    ],
  ])(
    '⭐ H2: operator X bilan timeout, qayta urinish rad etildi (%s) — «🎧 Operator» taklif qilinmaydi',
    async (_n, rejection) => {
      // Rad etilganda belgi bo'lgani uchun (1-urinish timeout) tanlov yopiq.
      const { ctx } = setup({
        confirm: [
          () => new Error('timeout'),
          batch({ index: 0, ok: false, code: 'create_failed', ...rejection }),
        ],
      });
      await send(ctx, ORDER_TEXT);
      await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
      await press(ctx, buttons(ctx)['Operator 01']);
      await press(ctx, buttons(ctx)['✅ Yaratish']);
      await press(ctx, buttons(ctx)['✅ Yaratish']);
      expect(lastShown(ctx)).not.toContain(AI_OPERATOR_REJECTED_TEXT);
      expect(lastShown(ctx)).toContain('operatorsiz yuboradi');
      expect(lastShown(ctx)).toContain(AI_RETRY_HINT_TEXT);
      expect(Object.keys(buttons(ctx)).some((k) => k.startsWith('🎧'))).toBe(
        false,
      );
    },
  );

  it('⭐ F2: operator tekshiruvi ishlamadi (validation_unavailable + «Tanlangan operatorni …») — rad etish EMAS, tanlov saqlanadi', async () => {
    const { ctx, calls } = setup({
      confirm: [
        batch({
          index: 0,
          ok: false,
          code: 'validation_unavailable',
          reason:
            'Tanlangan operatorni tekshirib bo‘lmadi — birozdan so‘ng qayta yuboring',
        }),
      ],
    });
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 02']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(row(ctx).status).toBe('preview');
    expect(row(ctx).input.meta.operator_id).toBe('301');
    expect(lastShown(ctx)).not.toContain('qabul qilinmadi');
    expect(
      calls.filter((c) => c.path === '/market-operators/selectable'),
    ).toHaveLength(1);
  });

  it('pickOperator faqat meta.operator_id/operator_name ni yozadi — input ning qolgani (parallel yozuv) saqlanadi', async () => {
    const { ctx } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['🎧 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    const original = ctx.aiDrafts.findOne.getMockImplementation()!;
    ctx.aiDrafts.findOne.mockImplementationOnce((args) =>
      original(args).then((draft) => {
        // O'qishdan keyin parallel yozuv (masalan profil keshi).
        row(ctx).input = {
          ...row(ctx).input,
          meta: {
            ...row(ctx).input.meta,
            profile: { phone: '+998900000099', required: true },
          },
        };
        return draft;
      }),
    );
    await press(ctx, picker['Operator 02']);
    expect(row(ctx).input.meta).toEqual(
      expect.objectContaining({
        operator_id: '301',
        operator_name: 'Operator 02',
        profile: { phone: '+998900000099', required: true },
      }),
    );
  });
});
