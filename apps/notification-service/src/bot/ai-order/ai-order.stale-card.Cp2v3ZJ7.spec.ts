import { Logger } from '@nestjs/common';
import { ACTION_UNKNOWN_TEXT } from '../bot-router.service';
import {
  callbackUpdate,
  makeRouter,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import {
  AI_ALREADY_CREATED_TEXT,
  AI_CANCELLED_TEXT,
  AI_EXPIRED_TEXT,
  AI_ORDER_ACTIONS,
} from './ai-order.service';

/**
 * Cp2v3ZJ7 #7 / TC12 — botda ESKI karta tugmasi ("eski nonce").
 *
 * BeePost'da nonce chat bo'yicha BITTA (`order_ai:mkcreate:${nonce}:${idx}`):
 * yangi tahlil eski ro'yxatni almashtiradi va eski kartaning `idx` i YANGI
 * ro'yxatga tushib, noto'g'ri buyurtma yaratishi mumkin edi — nonce shuni
 * to'sadi. Elchida (e7KhaeOO) har karta o'z nonce'iga ega: tugmada faqat
 * `a:<action_id>` (DB), u esa O'Z qoralamasining `draft_id` siga bog'langan;
 * mazmun DB'dagi o'sha qoralamadan olinadi. Natija:
 *  - eski karta hech qachon boshqa (yangi) kartaning mazmunini yaratmaydi;
 *  - yaroqsiz holatdagi eski karta (muddati o'tgan, yaratilgan, bekor
 *    qilingan, tozalangan) — ANIQ xabar, hech narsa yaratilmaydi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const DRAFT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DRAFT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const preview = (name: string, phone: string, price: number) => ({
  index: 0,
  ready: true,
  issues: [],
  customer_name: name,
  phone_number: phone,
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
      product_id: null,
      resolved_name: null,
      unresolved: true,
    },
  ],
  total_price: price,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: null,
});

const TEXT_A = 'Ali Valiyev +998901234567 Asaka, Atir 50ml, 150000';
const TEXT_B = 'Vali Aliyev +998907654321 Asaka, Atir 50ml, 99000';

type Call = { path: string; body: any };

function setup() {
  const calls: Call[] = [];
  let order = 80;
  const gateway = jest.fn(
    (_tg: string, _method: string, path: string, body: any) => {
      calls.push({ path, body });
      if (path === '/orders/ai-parse') {
        const isA = (body as FormData).get('text') === TEXT_A;
        return Promise.resolve({
          status: 200,
          body: {
            data: {
              ok: true,
              draft_id: isA ? DRAFT_A : DRAFT_B,
              orders: [
                isA
                  ? preview('Ali Valiyev', '+998901234567', 150000)
                  : preview('Vali Aliyev', '+998907654321', 99000),
              ],
            },
          },
        });
      }
      if (path === '/orders/ai-confirm') {
        order += 1;
        return Promise.resolve({
          status: 200,
          body: {
            data: {
              results: [{ index: 0, ok: true, order_id: String(order) }],
            },
          },
        });
      }
      return Promise.resolve({ status: 404, body: null });
    },
  );
  const ctx = makeRouter({
    actor: {
      user_id: '40',
      role: 'market_operator',
      status: 'active',
      market_id: '37',
      region_id: null,
    } as never,
    gateway,
    aiOrder: true,
  });
  const send = (text: string, updateId: number) =>
    ctx.router.dispatch('elchi', textUpdate(text, { chatId: 40, updateId }));
  const press = (data: string) =>
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: 40, fromId: 40 }),
    );
  /** Bot qoralamasi (telegram_ai_drafts) — AI draft_id bo'yicha. */
  const botDraftOf = (aiDraftId: string) =>
    [...ctx.aiDrafts.rows.values()].find((d) => d.ai_draft_id === aiDraftId)!;
  /** Shu qoralama kartasidagi tugma `callback_data` si. */
  const button = (aiDraftId: string, action: string) => {
    const draftId = botDraftOf(aiDraftId).id;
    const row = [...ctx.actions.rows.values()]
      .filter(
        (r) =>
          r.action === action &&
          (r.payload as { draft_id?: string }).draft_id === draftId,
      )
      .at(-1)!;
    return `a:${row.action_id}`;
  };
  const confirms = () => calls.filter((c) => c.path === '/orders/ai-confirm');
  const toast = () =>
    (
      ctx.transport.answerCallbackQuery.mock.calls.at(-1) as unknown as
        | [string, string?]
        | undefined
    )?.[1];
  return { ctx, calls, send, press, botDraftOf, button, confirms, toast };
}

describe('Cp2v3ZJ7 TC12 — botda eski karta tugmasi (nonce)', () => {
  it('⭐ eski karta (A) yangi karta (B) chiqqandan keyin bosilsa — faqat O‘Z mazmuni (A) yuboriladi, B niki EMAS', async () => {
    const fx = setup();
    await fx.send(TEXT_A, 1);
    await fx.send(TEXT_B, 2);
    expect(fx.ctx.aiDrafts.rows.size).toBe(2);

    // Eski karta A ning "✅ Yaratish" i.
    await fx.press(fx.button(DRAFT_A, AI_ORDER_ACTIONS.confirm));
    expect(fx.confirms()).toHaveLength(1);
    const [a] = fx.confirms()[0].body.orders;
    expect(a).toEqual(
      expect.objectContaining({
        draft_id: DRAFT_A,
        ai_item_index: 0,
        total_price: 150000,
        customer: expect.objectContaining({
          name: 'Ali Valiyev',
          phone_number: '+998901234567',
        }),
      }),
    );
    // Har karta o'z barqaror kaliti bilan (server dedupe: ai:<market>:<draft>:<idx>).
    const requestA = fx.confirms()[0].body.request_id;

    // B o'z mazmuni bilan, A ga ta'sir qilmaydi.
    await fx.press(fx.button(DRAFT_B, AI_ORDER_ACTIONS.confirm));
    expect(fx.confirms()).toHaveLength(2);
    const [b] = fx.confirms()[1].body.orders;
    expect(b).toEqual(
      expect.objectContaining({
        draft_id: DRAFT_B,
        total_price: 99000,
        customer: expect.objectContaining({ name: 'Vali Aliyev' }),
      }),
    );
    expect(fx.confirms()[1].body.request_id).not.toBe(requestA);
    expect(fx.botDraftOf(DRAFT_A).status).toBe('created');
    expect(fx.botDraftOf(DRAFT_B).status).toBe('created');
  });

  it.each([
    [
      'yaratilgan kartaning eski tugmasi',
      async (fx: ReturnType<typeof setup>) => {
        await fx.press(fx.button(DRAFT_A, AI_ORDER_ACTIONS.confirm));
      },
      AI_ALREADY_CREATED_TEXT,
      1,
    ],
    [
      'bekor qilingan kartaning eski tugmasi',
      async (fx: ReturnType<typeof setup>) => {
        await fx.press(fx.button(DRAFT_A, AI_ORDER_ACTIONS.cancel));
      },
      AI_CANCELLED_TEXT,
      0,
    ],
    [
      'muddati (24 soat) o‘tgan qoralama',
      (fx: ReturnType<typeof setup>) => {
        fx.botDraftOf(DRAFT_A).expires_at = new Date(Date.now() - 1000);
        return Promise.resolve();
      },
      AI_EXPIRED_TEXT,
      0,
    ],
    [
      'tozalangan (prune) qoralama — tugma hali tirik',
      (fx: ReturnType<typeof setup>) => {
        fx.ctx.aiDrafts.rows.delete(fx.botDraftOf(DRAFT_A).id);
        return Promise.resolve();
      },
      AI_EXPIRED_TEXT,
      0,
    ],
  ])(
    '⭐ %s → aniq xabar, ai-confirm qayta chaqirilmaydi',
    async (_label, prepare, expected, confirmsBefore) => {
      const fx = setup();
      await fx.send(TEXT_A, 1);
      const confirm = fx.button(DRAFT_A, AI_ORDER_ACTIONS.confirm);
      await prepare(fx);
      expect(fx.confirms()).toHaveLength(confirmsBefore);
      await fx.press(confirm);
      expect(sentTexts(fx.ctx).at(-1)).toBe(expected);
      expect(fx.confirms()).toHaveLength(confirmsBefore);
    },
  );

  it('⭐ tugmaning o‘zi eskirgan (24 soatdan keyin) — "Bu ro‘yxat eskirgan — matnni qayta yuboring", hech narsa chaqirilmaydi', async () => {
    const fx = setup();
    await fx.send(TEXT_A, 1);
    const confirm = fx.button(DRAFT_A, AI_ORDER_ACTIONS.confirm);
    fx.ctx.actions.rows.get(confirm.slice(2))!.expires_at = new Date(
      Date.now() - 1000,
    );
    await fx.press(confirm);
    expect(fx.toast()).toBe(AI_EXPIRED_TEXT);
    expect(AI_EXPIRED_TEXT).toContain('eskirgan');
    expect(AI_EXPIRED_TEXT).toContain('qayta yuboring');
    expect(fx.confirms()).toHaveLength(0);
    expect(fx.botDraftOf(DRAFT_A).status).toBe('preview');
  });

  it('⭐ juda eski karta (tugma tozalangan, >48 soat) yoki soxta tugma — "Bu tugma eskirgan", hech narsa yaratilmaydi', async () => {
    const fx = setup();
    await fx.send(TEXT_A, 1);
    const confirm = fx.button(DRAFT_A, AI_ORDER_ACTIONS.confirm);
    fx.ctx.actions.rows.delete(confirm.slice(2));
    await fx.press(confirm);
    expect(fx.toast()).toBe(ACTION_UNKNOWN_TEXT);
    expect(ACTION_UNKNOWN_TEXT).toContain('eskirgan');
    await fx.press('a:ZZZZZZZZZZZZZZZZ');
    expect(fx.toast()).toBe(ACTION_UNKNOWN_TEXT);
    expect(fx.confirms()).toHaveLength(0);
  });
});
