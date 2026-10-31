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
import { BotController } from './bot.controller';
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
 *  - callback'da identity uzilsa tugma aylanib qolmaydi (javob matni);
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
  const handler: BotActionHandler = {
    action: 'test.confirm',
    handle,
  };
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

  it('⭐ ikki marta xato — shaxsiy chatga «⚠️ Xatolik yuz berdi»', async () => {
    const { handler, handle } = flaky(2);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '44',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: false,
    });
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(sentTexts(ctx)).toEqual([BOT_ERROR_TEXT]);
  });

  it('bir martalik tugma xatoda YOPIQ qoladi (qayta ochish — B, kalit bilan): amal ikkinchi marta ketmaydi', async () => {
    const { handler, handle } = flaky(2);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '44',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(1);
    expect([...ctx.actions.rows.values()][0].consumed_at).not.toBeNull();
    await press(ctx, data);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('guruhda oxirgi xato — guruhga matn YUBORILMAYDI', async () => {
    const { handler } = flaky(2);
    const ctx = setup(handler);
    const data = await ctx.actions.create({
      chatId: '-100555',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: false,
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

  it('⭐ tugma bosilganda identity uzilsa — tugma aylanib qolmaydi (guruhda ham javob)', async () => {
    const handle = jest.fn(() => Promise.resolve());
    const ctx = makeRouter({
      actor: courierActor('44'),
      actionHandlers: [{ action: 'test.confirm', handle }],
    });
    ctx.actors.resolve.mockImplementation(() =>
      Promise.reject(new BotIdentityUnavailableError(new Error('timeout'))),
    );
    const data = await ctx.actions.create({
      chatId: '-100555',
      action: 'test.confirm',
      actorUserId: '44',
      oneShot: true,
    });
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: -100555, fromId: 44, chatType: 'group' }),
    );
    expect(ctx.transport.answerCallbackQuery).toHaveBeenCalledWith(
      expect.any(String),
      BOT_IDENTITY_UNAVAILABLE_TEXT,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(sentTexts(ctx)).toEqual([]);
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

describe('BOT-3d — update_id bo`yicha takror (webhook 503 → Telegram qayta yuboradi)', () => {
  it('⭐ ayni update_id ikkinchi marta kelsa — ishlanmaydi (iste`molchi dedup)', async () => {
    const seen = new Set<number>();
    const limiter = {
      firstSeen: jest.fn((id: number) => {
        const fresh = !seen.has(id);
        seen.add(id);
        return Promise.resolve(fresh);
      }),
    };
    const router = { dispatch: jest.fn().mockResolvedValue('done') };
    const controller = new BotController(
      { ack: jest.fn() } as never,
      {
        ready: jest.fn().mockResolvedValue(undefined),
        acceptsWebhook: () => true,
      } as never,
      router as never,
      limiter as never,
    );
    const event = {
      bot_slug: 'elchi',
      update: { update_id: 9001, message: { chat: { id: 44 } } },
    };
    await controller.onTelegramUpdate(event, {} as never);
    await controller.onTelegramUpdate(event, {} as never);
    expect(router.dispatch).toHaveBeenCalledTimes(1);
  });
});
