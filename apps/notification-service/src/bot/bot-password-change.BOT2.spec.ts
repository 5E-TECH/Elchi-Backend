import {
  BOT_PASSWORD_CHANGE_TEXT,
  BotGatewayClient,
  BotPasswordChangeRequiredError,
} from './bot-gateway.client';
import { of } from 'rxjs';
import { BotRouterService } from './bot-router.service';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
  sentTexts,
} from './testing/bot-kit-spec';

/**
 * BOT-2 #2d — gateway `403 PASSWORD_CHANGE_REQUIRED` → bot aniq javob
 * beradi («Avval kabinetda parolni almashtiring»), qayta urinmaydi.
 */
describe('BOT-2 #2d — parolni almashtirish shart', () => {
  const client = (status: number, body: unknown) => {
    const c = new BotGatewayClient(
      { send: jest.fn(() => of({ accessToken: 't' })) } as never,
      { get: () => '' } as never,
    );
    c.fetchImpl = () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    return c;
  };

  it('⭐ 403 PASSWORD_CHANGE_REQUIRED → BotPasswordChangeRequiredError', async () => {
    await expect(
      client(403, {
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
      }).request('5550007', 'GET', '/orders'),
    ).rejects.toBeInstanceOf(BotPasswordChangeRequiredError);
  });

  it('boshqa 403 — avvalgidek javob', async () => {
    await expect(
      client(403, { statusCode: 403, message: 'no' }).request(
        '5550007',
        'GET',
        '/orders',
      ),
    ).resolves.toEqual({
      status: 403,
      body: { statusCode: 403, message: 'no' },
    });
  });

  it('matn aniq', () => {
    expect(BOT_PASSWORD_CHANGE_TEXT).toContain(
      'Avval kabinetda parolni almashtiring',
    );
  });
});

describe('BOT-2 #2d — BotRouterService javobi', () => {
  const router = (error: Error) => {
    const reply = jest.fn().mockResolvedValue(undefined);
    const r = Object.create(BotRouterService.prototype) as Record<string, any>;
    r.buildContext = () => ({ reply });
    r.handleUpdate = jest.fn(() => Promise.reject(error));
    return { r, reply };
  };

  it('⭐ parol xatosi → aniq matn, throw yo`q (qayta urinish yo`q)', async () => {
    const { r, reply } = router(new BotPasswordChangeRequiredError());
    await expect(r.process({ update_id: 1 }, '7')).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledWith(BOT_PASSWORD_CHANGE_TEXT);
  });

  it('boshqa xato — avvalgidek yuqoriga', async () => {
    const { r, reply } = router(new Error('boom'));
    await expect(r.process({ update_id: 1 }, '7')).rejects.toThrow('boom');
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('BOT-2 #2d — haqiqiy handler orqali (catch xatoni yutmaydi)', () => {
  it('⭐ kvitansiya «👍» — gateway 403 PASSWORD_CHANGE_REQUIRED → «Avval kabinetda parolni almashtiring», «aloqa xatosi» EMAS', async () => {
    const gateway = jest.fn(() =>
      Promise.reject(new BotPasswordChangeRequiredError()),
    );
    const ctx = makeRouter({ actor: courierActor('44'), gateway });
    const ok = await ctx.actions.create({
      chatId: '44',
      action: 'fp.ok',
      actorUserId: '44',
      payload: { payment_id: '701' },
      oneShot: false,
    });
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate(ok, { chatId: 44, fromId: 44 }),
    );
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(sentTexts(ctx)).toEqual([BOT_PASSWORD_CHANGE_TEXT]);
  });

  it('⭐ kuryer /kun — parol xatosi umumiy «Ma`lumotni olib bo`lmadi» bilan yutilmaydi', async () => {
    const gateway = jest.fn(() =>
      Promise.reject(new BotPasswordChangeRequiredError()),
    );
    const ctx = makeRouter({ actor: courierActor('44'), gateway });
    await ctx.router.dispatch('elchi', {
      update_id: 9,
      message: {
        message_id: 1,
        chat: { id: 44, type: 'private' },
        from: { id: 44 },
        text: '/kun',
      },
    });
    expect(sentTexts(ctx)).toEqual([BOT_PASSWORD_CHANGE_TEXT]);
  });
});
