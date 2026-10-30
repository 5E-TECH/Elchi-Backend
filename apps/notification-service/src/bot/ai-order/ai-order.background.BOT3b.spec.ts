import { Logger } from '@nestjs/common';
import { makeRouter, sentTexts, textUpdate } from '../testing/bot-kit-spec';
import { AI_NETWORK_TEXT, AI_WORKING_TEXT } from './ai-order.service';

/**
 * BOT-3b — AI FONDA: bot update'i «⏳» bilan darhol tugaydi (AI javobini
 * kutmaydi), qoralamani ishchi oladi va QAYTA URINMAYDI; ayni update ikki
 * marta kelsa (router qayta ishlashi / qayta yetkazish) — bitta qoralama,
 * bitta AI chaqiruvi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const ORDER_TEXT =
  'Ali Valiyev +998901234567 Andijon Asaka, Atir 50ml 2 ta, 150000';

function setup(parse: () => Promise<{ status: number; body: unknown }>) {
  const gateway = jest.fn((_tg: string, _method: string, path: string) =>
    path === '/orders/ai-parse'
      ? parse()
      : Promise.resolve({ status: 404, body: null }),
  );
  const ctx = makeRouter({
    actor: {
      user_id: '40',
      role: 'market',
      status: 'active',
      market_id: null,
      region_id: null,
    },
    gateway,
    aiOrder: true,
  });
  const aiCalls = () =>
    gateway.mock.calls.filter(([, , path]) => path === '/orders/ai-parse');
  return { ctx, gateway, aiCalls };
}

describe('BOT-3b — AI fonda', () => {
  it('⭐ update AI javobini KUTMAYDI: «⏳» yuboriladi, dispatch AI tugamasdan tugaydi', async () => {
    let release: (v: { status: number; body: unknown }) => void = () =>
      undefined;
    const { ctx, aiCalls } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await expect(
      ctx.router.dispatch('elchi', textUpdate(ORDER_TEXT, { chatId: 40 })),
    ).resolves.toBe('done');
    expect(sentTexts(ctx)).toEqual([AI_WORKING_TEXT]);
    // AI hali ishlayapti — qoralama parsing, ishchi olgan.
    const [draft] = [...ctx.aiDrafts.rows.values()];
    expect(draft.status).toBe('parsing');
    expect(draft.worker_at).toBeTruthy();
    expect(aiCalls()).toHaveLength(1);
    release({ status: 200, body: { data: { ok: true, orders: [] } } });
    await ctx.aiService!.idle();
    expect(draft.status).toBe('empty');
  });

  it('⭐ ayni update ikki marta (qayta yetkazish) — bitta qoralama, bitta AI chaqiruvi', async () => {
    const { ctx, aiCalls } = setup(() =>
      Promise.resolve({
        status: 200,
        body: { data: { ok: true, orders: [] } },
      }),
    );
    const update = textUpdate(ORDER_TEXT, { chatId: 40, updateId: 77 });
    await ctx.router.dispatch('elchi', update);
    // Dedup (limiter) chetlab o'tilgan holat: AiOrderService o'zi ham himoyalaydi.
    await ctx.aiService!.start(
      { chatId: '40', update, reply: jest.fn() } as never,
      '40',
      { text: ORDER_TEXT },
    );
    await ctx.aiService!.idle();
    expect(ctx.aiDrafts.rows.size).toBe(1);
    expect(aiCalls()).toHaveLength(1);
  });

  it('⭐ AI xatosi — router QAYTA URINMAYDI (AI bir marta), «🔁 Qayta urinish» chiqadi', async () => {
    const { ctx, aiCalls } = setup(() => Promise.reject(new Error('timeout')));
    await ctx.router.dispatch('elchi', textUpdate(ORDER_TEXT, { chatId: 40 }));
    await ctx.aiService!.idle();
    expect(aiCalls()).toHaveLength(1);
    const texts = [
      ...sentTexts(ctx),
      ...(
        ctx.transport.editMessage.mock.calls as unknown as Array<
          [string, string, { text: string }]
        >
      ).map((call) => call[2].text),
    ];
    expect(texts).toContain(AI_NETWORK_TEXT);
    const [draft] = [...ctx.aiDrafts.rows.values()];
    expect(draft.status).toBe('failed');
  });
});
