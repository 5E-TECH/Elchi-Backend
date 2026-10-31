import { Logger } from '@nestjs/common';
import type { BotActionHandler } from './handlers/bot-context';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
} from './testing/bot-kit-spec';

/**
 * BOT-3d (B): handler xatosida bir martalik tugma faqat `retrySafe` bo'lsa
 * QAYTA OCHILADI — qayta bosish ayni `Idempotency-Key` bilan ketadi, backend
 * takrorni ushlaydi. Bayroqsiz — yopiq qoladi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const flaky = (failures: number, retrySafe = true) => {
  let calls = 0;
  const handle = jest.fn(() => {
    calls += 1;
    return calls <= failures
      ? Promise.reject(new Error('order-service down'))
      : Promise.resolve();
  });
  const handler: BotActionHandler = {
    action: 'test.confirm',
    retrySafe,
    handle,
  };
  return { handler, handle };
};

describe('BOT-3d — retrySafe: tugma qayta ochiladi', () => {
  const setup = (handler: BotActionHandler) =>
    makeRouter({ actor: courierActor('44'), actionHandlers: [handler] });
  const press = (ctx: ReturnType<typeof makeRouter>, data: string) =>
    ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: 44, fromId: 44 }),
    );

  it('⭐ ikki marta xato — tugma QAYTA OCHIQ; keyingi bosish ishlaydi (bitta amal)', async () => {
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
    const [action] = [...ctx.actions.rows.values()];
    expect(action.consumed_at).toBeNull();
    // «✅ Ha» qayta — endi ishlaydi, keyin tugma yopiq.
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(3);
    expect(action.consumed_at).not.toBeNull();
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('bir marta xato — ichki qayta urinish ishlaydi (tugma qayta ochilgani uchun)', async () => {
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
    expect([...ctx.actions.rows.values()][0].consumed_at).not.toBeNull();
  });

  it('⭐ retrySafe EMAS (kalitsiz amal) — xatoda tugma YOPIQ qoladi: qisman bajarilgan amal ikkinchi marta ketmaydi', async () => {
    const { handler, handle } = flaky(2, false);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '44',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await press(ctx, data);
    // Ichki qayta urinish tugmani band ko'radi — handler bir marta.
    expect(handle).toHaveBeenCalledTimes(1);
    expect([...ctx.actions.rows.values()][0].consumed_at).not.toBeNull();
    expect(ctx.actions.release).not.toHaveBeenCalled();
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
