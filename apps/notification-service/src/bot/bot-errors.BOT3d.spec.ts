import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  BotActorService,
  BotIdentityUnavailableError,
} from './bot-actor.service';
import {
  BOT_ERROR_TEXT,
  BOT_IDENTITY_UNAVAILABLE_TEXT,
} from './bot-router.service';
import type { BotActionHandler } from './handlers/bot-context';
import {
  COURIER_OP_TIMEOUT_MS,
  COURIER_OP_UNKNOWN_TEXT,
  CourierService,
} from './courier/courier.service';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
  sentTexts,
  textUpdate,
} from './testing/bot-kit-spec';

/**
 * BOT-3d (NIMA 10–11) — xato jim yutilmaydi:
 *  - update ikki marta xato bersa shaxsiy chatga «⚠️ Xatolik yuz berdi»
 *    (guruhga yo'q);
 *  - handler xatosida bir martalik tugma QAYTA OCHILADI — «✅ Ha» ni qayta
 *    bosish ishlaydi, bir kalit — bitta amal;
 *  - identity javob bermasa «Tizim vaqtincha ishlamayapti» («avval ulang»
 *    EMAS).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const flaky = (failures: number) => {
  let calls = 0;
  const handle = jest.fn(() => {
    calls += 1;
    return calls <= failures
      ? Promise.reject(new Error('order-service down'))
      : Promise.resolve();
  });
  const handler: BotActionHandler = { action: 'test.confirm', handle };
  return { handler, handle };
};

describe('BOT-3d — handler xatosi: tugma qayta ochiladi, oxirgi xatoda matn', () => {
  const setup = (handler: BotActionHandler) => {
    const ctx = makeRouter({
      actor: courierActor('44'),
      actionHandlers: [handler],
    });
    return ctx;
  };
  const press = async (
    ctx: ReturnType<typeof makeRouter>,
    data: string,
    chatId = 44,
  ) =>
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, {
        chatId,
        fromId: 44,
        chatType: chatId < 0 ? 'group' : 'private',
      }),
    );

  it('⭐ ikki marta xato — tugma QAYTA OCHIQ, shaxsiy chatga «⚠️ Xatolik yuz berdi»; keyingi bosish ishlaydi (bitta amal)', async () => {
    const { handler, handle } = flaky(2);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '44',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(sentTexts(ctx)).toEqual([BOT_ERROR_TEXT]);
    const [action] = [...ctx.actions.rows.values()];
    expect(action.consumed_at).toBeNull();
    // «✅ Ha» qayta — endi ishlaydi, keyin tugma yopiq.
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(3);
    expect(action.consumed_at).not.toBeNull();
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('bir marta xato — ichki qayta urinish ishlaydi (tugma qayta ochilgani uchun), matn yo`q', async () => {
    const { handler, handle } = flaky(1);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '44',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(sentTexts(ctx)).toEqual([]);
    expect([...ctx.actions.rows.values()][0].consumed_at).not.toBeNull();
  });

  it('guruhda oxirgi xato — guruhga matn YUBORILMAYDI', async () => {
    const { handler } = flaky(2);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '-100555',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await press(ctx, data, -100555);
    expect(sentTexts(ctx)).toEqual([]);
  });
});

describe('BOT-3d — identity ishlamayapti', () => {
  it('⭐ «Tizim vaqtincha ishlamayapti» — «avval ulang» EMAS, qayta urinilmaydi', async () => {
    const ctx = makeRouter({ actor: courierActor('44') });
    ctx.actors.resolve.mockImplementation(() =>
      Promise.reject(new BotIdentityUnavailableError(new Error('timeout'))),
    );
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 44 }));
    expect(sentTexts(ctx)).toEqual([BOT_IDENTITY_UNAVAILABLE_TEXT]);
    expect(ctx.actors.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('BOT-3d — BotActorService', () => {
  it('identity RPC xatosi → BotIdentityUnavailableError (null EMAS); bog`lanmagan → null', async () => {
    const down = new BotActorService({
      send: jest.fn(() => throwError(() => new Error('timeout'))),
    } as never);
    await expect(down.resolve('5550044')).rejects.toBeInstanceOf(
      BotIdentityUnavailableError,
    );
    const unlinked = new BotActorService({
      send: jest.fn(() => of({ data: null })),
    } as never);
    await expect(unlinked.resolve('5550044')).resolves.toBeNull();
  });
});

describe('BOT-3d — kuryer amali: natija noma`lum', () => {
  const make = (request: jest.Mock) =>
    new CourierService(
      { request } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => 'https://admin.elchi.test' } as never,
    );

  it('⭐ 65 s kutadi (gateway 60 s dan uzun), kalit uzatiladi; timeout → «⏳ Natija noma`lum», «bajarilmadi» EMAS', async () => {
    const request = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        }),
      ),
    );
    const outcome = await make(request).perform('25', 'cnd', '81', {
      reason: 'Mijoz telefonni olmadi',
      idempotencyKey: 'tg:act0000000000001',
    });
    expect(outcome).toEqual({
      kind: 'error',
      message: COURIER_OP_UNKNOWN_TEXT,
    });
    expect(request).toHaveBeenCalledWith(
      '25',
      'POST',
      '/orders/81/could-not-deliver',
      expect.anything(),
      {
        timeoutMs: COURIER_OP_TIMEOUT_MS,
        idempotencyKey: 'tg:act0000000000001',
      },
    );
    expect(COURIER_OP_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it.each([502, 503, 504])(
    '⭐ gateway %i — inglizcha matn emas, «⏳ Natija noma`lum»',
    async (status) => {
      const request = jest.fn(() =>
        Promise.resolve({
          status,
          body: { message: 'Gateway Timeout' },
        }),
      );
      const outcome = await make(request).perform('25', 'sell', '81', {});
      expect(outcome).toEqual({
        kind: 'error',
        message: COURIER_OP_UNKNOWN_TEXT,
      });
    },
  );
});
