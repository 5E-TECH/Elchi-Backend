import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  makeRouter,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_OPERATOR_PHONE_RETRY_TEXT,
  AI_RETRY_HINT_TEXT,
} from './ai-order-operator';
import type { AiPreviewOrder } from './ai-preview';

/**
 * Bot AI preview: «👤 Operator» tanlovi (faqat market) va operator raqami
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

describe('«👤 Operator» tanlovi', () => {
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
      '👤 Operator: tanlanmagan',
      '✏️ Tuzatish',
      '❌ Bekor',
    ]);
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
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
    expect(Object.keys(buttons(ctx))).toContain('👤 Operator: Operator 02');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls).operator_id).toBe('301');
  });

  it('«🚫 Tanlamaslik» — operator_id yuborilmaydi', async () => {
    const { ctx, calls } = setup();
    await send(ctx, ORDER_TEXT);
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
    await press(ctx, buttons(ctx)['Operator 01']);
    await press(ctx, buttons(ctx)['👤 Operator: Operator 01']);
    await press(ctx, buttons(ctx)['🚫 Tanlamaslik']);
    expect(Object.keys(buttons(ctx))).toContain('👤 Operator: tanlanmagan');
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(sentOrder(calls)).not.toHaveProperty('operator_id');
  });

  it('market operatori: ro‘yxat so‘ralmaydi, tugma yo‘q, operator_id hech qachon yuborilmaydi', async () => {
    const { ctx, calls } = setup({ role: 'market_operator' });
    await send(ctx, ORDER_TEXT);
    expect(calls.map((c) => c.path)).toEqual(['/orders/ai-parse']);
    expect(Object.keys(buttons(ctx)).some((k) => k.startsWith('👤'))).toBe(
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
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
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
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
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
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
    const picker = buttons(ctx);
    await press(ctx, picker['↩️ Orqaga']);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(typeof row(ctx).orders[0].confirm_attempted_at).toBe('number');
    expect(Object.keys(buttons(ctx)).some((k) => k.startsWith('👤'))).toBe(
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

  it('market: profil so‘rovi yiqilsa — raqamsiz yuboriladi (server sababi ko‘rsatiladi)', async () => {
    const { ctx, calls } = setup({
      profile: () => ({ status: 500, body: null }),
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
    expect(lastShown(ctx)).toContain(`❌ 1) ${PHONE_REQUIRED}`);
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
    expect(lastShown(ctx)).toContain(PHONE_REQUIRED);
    expect(lastShown(ctx)).toContain(AI_OPERATOR_PHONE_RETRY_TEXT);
    expect(lastShown(ctx)).toContain(AI_RETRY_HINT_TEXT);

    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(calls.filter((c) => c.path === '/auth/my-profile')).toHaveLength(1);
    expect(sentOrder(calls, 1).operator_phone).toBe('+998900000099');
    expect(row(ctx).status).toBe('created');
  });
});

describe('natija xatolari', () => {
  it('noto‘g‘ri operator — create_failed, server sababi ko‘rsatiladi (qayta urinish yo‘q)', async () => {
    const reason = 'Operator topilmadi yoki faol emas';
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
    await press(ctx, buttons(ctx)['👤 Operator: tanlanmagan']);
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
    // Yuborilganlar belgilangan — tuzatish yopiq (yaratilgani takrorlanadi).
    expect(
      row(ctx).orders.every(
        (o: AiPreviewOrder) => typeof o.confirm_attempted_at === 'number',
      ),
    ).toBe(true);
    expect(Object.keys(buttons(ctx))).toEqual([
      '✅ Yaratish',
      '❌ Bekor',
      '🌐 Kabinetda yaratish',
    ]);
    await press(ctx, buttons(ctx)['✅ Yaratish']);
    expect(confirms(calls)).toHaveLength(2);
    expect(row(ctx).status).toBe('created');
    expect(lastShown(ctx)).toContain('avval yaratilgan');
  });
});
