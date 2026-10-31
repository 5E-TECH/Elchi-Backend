import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  courierActor,
  fakeOrdersGateway,
  gatewayOrder,
  lastButtons,
  makeRouter,
  sentTexts,
  shownTexts,
  textUpdate,
} from '../testing/bot-kit-spec';

/**
 * BOT-3d (NIMA 12): kuryer amali idempotentligi — javob yo'qolganda «Ha»
 * qayta bosilsa backend'da baribir BITTA amal bo'ladi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

type Ctx = ReturnType<typeof makeRouter>;
const press = (ctx: Ctx, data: string) =>
  ctx.router.dispatch(
    'elchi',
    callbackUpdate(data, { chatId: 25, fromId: 25 }),
  );

/**
 * Backend'ni taqlid qiladi: `Idempotency-Key` bo'yicha natijani eslab
 * qoladi (gateway → order-service `courier-op` kaliti). Birinchi POST
 * backend'da BAJARILADI, lekin javob yo'qoladi (504).
 */
function lossyBackend() {
  const inner = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
  const results = new Map<string, { status: number; body: unknown }>();
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
      if (method === 'POST' && key) {
        const cached = results.get(key);
        if (cached) return cached;
        executed += 1;
        const result = await inner.request(tg, method, path, body, opts);
        results.set(key, result);
        if (lose) {
          lose = false;
          return { status: 504, body: { message: 'Gateway Timeout' } };
        }
        return result;
      }
      return inner.request(tg, method, path, body, opts);
    },
  );
  return { request, inner, executed: () => executed };
}

describe('BOT-3d — kuryer amali idempotent (NIMA 12)', () => {
  it('⭐ birinchi urinish backend’ga yetgan, javob yo‘qolgan → «Ha» qayta → backend’da BITTA amal', async () => {
    const backend = lossyBackend();
    const ctx = makeRouter({ actor: courierActor(), gateway: backend.request });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const yes = lastButtons(ctx)['✅ Ha'];

    await press(ctx, yes);
    // Natija noma'lum — tugma qaytariladi, «Ha» yana bosiladi.
    expect(shownTexts(ctx).join('\n')).toContain("Natija noma'lum");
    expect(backend.executed()).toBe(1);
    expect(backend.inner.orders.get('101')!.status).toBe('sold');

    await press(ctx, yes);
    const posts = backend.request.mock.calls.filter(
      (call) => call[1] === 'POST',
    );
    expect(posts).toHaveLength(2);
    // Ikkala urinish ham AYNAN bitta kalit bilan.
    const keys = posts.map(
      (call) => (call[4] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(backend.executed()).toBe(1);
    expect(shownTexts(ctx)).toContain('#101 — sotildi ✅');
  });

  it('«Ha» bosilganda darhol «⏳» javob (answerCallbackQuery), natija tasdiq xabarini tahrirlab yoziladi', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    await press(ctx, lastButtons(ctx)['✅ Sotildi']);
    const sendsBefore = sentTexts(ctx).length;
    await press(ctx, lastButtons(ctx)['✅ Ha']);
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('⏳'),
    );
    // Natija yangi xabar emas — tahrir.
    expect(sentTexts(ctx).slice(sendsBefore)).not.toContain(
      '#101 — sotildi ✅',
    );
    const edited = ctx.transport.editMessage.mock.calls.map(
      (call) => ((call as unknown[])[2] as { text?: string }).text,
    );
    expect(edited).toContain('#101 — sotildi ✅');
  });

  it('⭐ isbot urinishlari — har biriga YANGI kalit: sell → ortga → yana sell haqiqatan bajariladi (keshdagi eski javob emas)', async () => {
    // Backend kalit bo'yicha natijani abadiy eslaydi (order-service kabi).
    const inner = fakeOrdersGateway([
      gatewayOrder('101', 'waiting', {
        market: { id: '3', expense_proof_conditions: ['sell_any'] },
      }),
    ]);
    const cache = new Map<string, unknown>();
    const request = jest.fn(
      async (
        tg: string,
        method: string,
        path: string,
        body?: unknown,
        opts?: { idempotencyKey?: string },
      ) => {
        const key = opts?.idempotencyKey;
        if (method === 'POST' && key && path.startsWith('/orders/')) {
          if (cache.has(key)) return cache.get(key);
          const result = await inner.request(tg, method, path, body, opts);
          cache.set(key, result);
          return result;
        }
        return inner.request(tg, method, path, body, opts);
      },
    );
    const ctx = makeRouter({ actor: courierActor(), gateway: request });
    let updateId = 5000;
    const sellWithProof = async () => {
      await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
      await press(ctx, lastButtons(ctx)['✅ Sotildi']);
      await press(ctx, lastButtons(ctx)['✅ Ha']);
      const done = lastButtons(ctx)['✅ Tugatdim'];
      updateId += 1;
      await ctx.router.dispatch('elchi', {
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: 25, type: 'private' },
          from: { id: 25 },
          photo: [{ file_id: `f${updateId}`, file_size: 10_000 }],
        },
      });
      await press(ctx, done);
    };
    const sellKeys = () =>
      request.mock.calls
        .filter((call) => call[1] === 'POST' && call[2] === '/orders/sell/101')
        .map((call) => (call[4] as { idempotencyKey?: string }).idempotencyKey);

    await sellWithProof();
    expect(inner.orders.get('101')!.status).toBe('sold');
    // Ortga qaytarildi (boshqa yo'l bilan) — yana sotiladi.
    inner.orders.get('101')!.status = 'waiting';
    await sellWithProof();
    const [first, second] = sellKeys();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(inner.orders.get('101')!.status).toBe('sold');
  });
});
