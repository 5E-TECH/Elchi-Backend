import { NotificationServiceService } from './notification-service.service';
import { GroupHandler } from './bot/handlers/group.handler';
import { MarketHandler } from './bot/handlers/market.handler';
import {
  ENV_BOT_TOKEN,
  makeCtx,
  makeFetch,
  makeOutbox,
  marketActor,
  usedTokens,
} from './bot/testing/bot-kit-spec';

/**
 * FIX3 (A7):
 *  - CODE-02: notification bot guruhni FAQAT marketning joriy maxfiy
 *    market_tg_token'i bilan ulaydi — `group_token-<marketId>` yorlig'i va
 *    saqlangan eski token bo'yicha zaxira yo'q; /start va /help id formatini
 *    reklama qilmaydi; maxfiy token bazada saqlanmaydi va bot tokeni sifatida
 *    ishlatilmaydi; fix3b: token ulangandan keyin ALMASHTIRILMAYDI va mavjud
 *    (market, tur) ulanishi bot orqali almashtirilmaydi;
 *  - CODE-18: /status faqat ulangan (users.telegram_id) market/operatorga va
 *    faqat o'sha marketning buyurtmasi uchun javob beradi.
 * (ZlpXb4Wh) eski bot klasslari o'rniga yangi bot/ yadrosi handlerlari.
 */

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

const SECRET = 'group_token-0123456789abcdef0123456789abcdef';

const cmdCalls = (cmd: string) =>
  rmqSendMock.mock.calls.filter(([, pattern]) => pattern?.cmd === cmd);

describe('CODE-02: guruhni ulash faqat maxfiy token bilan', () => {
  let service: NotificationServiceService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let fetchMock: ReturnType<typeof makeFetch>;

  /** identity: faqat SECRET → 5-market; find_by_id → market; rotate → ok. */
  const routeIdentity = () =>
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }, payload: any) => {
        switch (pattern.cmd) {
          case 'identity.market.find_by_tg_token':
            return payload?.market_tg_token === SECRET
              ? Promise.resolve({
                  success: true,
                  data: { id: '5', name: 'Beshinchi' },
                })
              : Promise.reject(
                  Object.assign(new Error('Market topilmadi'), {
                    statusCode: 404,
                  }),
                );
          case 'identity.market.find_by_id':
            return Promise.resolve({
              success: true,
              data: { id: String(payload.id), name: 'Beshinchi' },
            });
          case 'identity.market.rotate_tg_token':
            return Promise.resolve({ statusCode: 200 });
          default:
            return Promise.resolve(null);
        }
      },
    );

  beforeEach(() => {
    rmqSendMock.mockReset();
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn(),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: '41', ...value }),
      ),
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    fetchMock = makeFetch();
    service = new NotificationServiceService(
      repo as never,
      {} as never,
      activityLog as never,
      makeOutbox(fetchMock).outbox,
    );
    routeIdentity();
  });

  it.each([
    'group_token-5',
    'group_token-5-create',
    'group_token-5-cancel',
    'GROUP_TOKEN-12',
  ])(
    '%s — market id bo‘yicha yorliq rad etiladi, hech narsa yozilmaydi',
    async (text) => {
      const res = await service.connectGroupByTokenText(text, '-100777');

      expect(res).toEqual({
        message: expect.stringContaining('Token formati'),
      });
      expect(rmqSendMock).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it('uzun raqamli "token" ham id sifatida emas, token sifatida tekshiriladi', async () => {
    const res = await service.connectGroupByTokenText(
      'group_token-12345678901234',
      '-100777',
    );

    expect(res).toEqual({ message: 'Token topilmadi yoki yaroqsiz' });
    expect(cmdCalls('identity.market.find_by_tg_token')).toHaveLength(1);
    expect(cmdCalls('identity.market.find_by_id')).toHaveLength(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('eski (almashtirilgan) token — saqlangan qator bo‘yicha zaxira YO‘Q', async () => {
    const stale = 'group_token-ffffffffffffffffffffffffffffffff';
    // Eski kod shu qatorni topib, guruhni qayta ulardi.
    repo.findOne.mockImplementation(({ where }: { where: any }) =>
      Promise.resolve(
        where?.token === stale
          ? { id: '41', market_id: '5', group_type: 'create', token: stale }
          : null,
      ),
    );

    const res = await service.connectGroupByTokenText(stale, '-100777');

    expect(res).toEqual({ message: 'Token topilmadi yoki yaroqsiz' });
    expect(
      repo.findOne.mock.calls.some(([arg]) => arg?.where?.token !== undefined),
    ).toBe(false);
    expect(repo.save).not.toHaveBeenCalled();
    expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
  });

  it('joriy maxfiy token — CREATE guruhi ulanadi, token saqlanmaydi va ALMASHTIRILMAYDI (fix3b)', async () => {
    const res = await service.connectGroupByTokenText(` ${SECRET} `, '-100777');

    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 201,
        message: 'Beshinchi uchun Telegram guruhi ulandi',
      }),
    );
    // bOMYoOtV: token ustuni umuman yozilmaydi (bot tokeni faqat env).
    expect(repo.create).toHaveBeenCalledWith({
      market_id: '5',
      group_id: '-100777',
      group_type: 'create',
      is_active: true,
    });
    // fix3b: token marketning order-bot kaliti bo'lib qoladi.
    expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
    expect(JSON.stringify(repo.save.mock.calls)).not.toContain(SECRET);
  });

  it('<token>-cancel — CANCEL guruhi, identity faqat toza token bilan so‘raladi', async () => {
    const res = await service.connectGroupByTokenText(
      `${SECRET}-cancel`,
      '-100888',
    );

    expect(res).toEqual(expect.objectContaining({ statusCode: 201 }));
    expect(cmdCalls('identity.market.find_by_tg_token')[0][2]).toEqual({
      market_tg_token: SECRET,
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ group_type: 'cancel' }),
    );
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('token');
  });

  it('mavjud (market, tur) ulanishi joriy token bilan ham ALMASHTIRILMAYDI (fix3b)', async () => {
    const existing = {
      id: '41',
      market_id: '5',
      group_id: '-100111',
      group_type: 'create',
      token: 'group_token-old',
      is_active: true,
    };
    repo.findOne.mockImplementation(({ where }: { where: any }) =>
      Promise.resolve(
        where?.market_id === '5' && where?.group_type === 'create'
          ? existing
          : null,
      ),
    );

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual({
      message:
        "Bu market uchun bu turdagi guruh allaqachon ulangan — admin orqali o'zgartiring",
    });
    expect(repo.save).not.toHaveBeenCalled();
    expect(existing.group_id).toBe('-100111');
    expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
  });

  it('guruh allaqachon ulangan bo‘lsa — rad etiladi (fix3b: xabar o‘zbekcha)', async () => {
    repo.findOne.mockImplementation(({ where }: { where: any }) =>
      Promise.resolve(where?.group_id === '-100777' ? { id: '9' } : null),
    );

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual({
      message: 'Bu guruh shu xabar turi uchun allaqachon ulangan',
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  describe('yuborish: bot tokeni FAQAT env (bOMYoOtV)', () => {
    it('eski qatordagi group_token-… e’tiborsiz — env bot yuboradi', async () => {
      repo.find.mockResolvedValue([
        {
          id: '41',
          market_id: '5',
          group_type: 'create',
          group_id: '-100777',
          token: SECRET,
        },
      ]);

      const res = await service.sendNotification({
        message: 'salom',
        market_id: '5',
      } as never);

      expect((res?.data as { success?: number } | undefined)?.success).toBe(1);
      expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN]);
    });

    it('qatorda haqiqiy bot tokeni bo‘lsa ham — ISHLATILMAYDI, env bot (bOMYoOtV #1)', async () => {
      repo.find.mockResolvedValue([
        {
          id: '42',
          market_id: '5',
          group_type: 'create',
          group_id: '-100777',
          token: '123456:REAL_BOT',
        },
      ]);

      await service.sendNotification({
        message: 'salom',
        market_id: '5',
      } as never);

      expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN]);
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('REAL_BOT');
    });
  });
});

describe('CODE-02: /start va /help market id formatini ko‘rsatmaydi', () => {
  it.each(['/start', '/help'])('%s (guruh)', async (command) => {
    const handler = new GroupHandler(
      { connectGroupByTokenText: jest.fn() } as never,
      { linkAttempt: jest.fn() } as never,
    );
    const { ctx, replies } = makeCtx({
      chatId: '-100777',
      chatType: 'supergroup',
      text: command,
    });

    expect(await handler.handle(ctx as never)).toBe(true);

    const message = replies[0].text;
    expect(message).toContain('maxfiy market token');
    expect(message).not.toMatch(/group_token-\d/);
    expect(message).not.toContain('marketId');
  });
});

describe('CODE-18: /status faqat o‘z marketi uchun (aktor = users.telegram_id)', () => {
  const handler = () => new MarketHandler({} as never);

  beforeEach(() => {
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }, payload: any) => {
        if (pattern.cmd !== 'order.find_by_id') return Promise.resolve(null);
        // order-service findById buyurtmani O'RAMSIZ qaytaradi.
        const orders: Record<string, unknown> = {
          '101': { id: '101', status: 'new', market_id: '5' },
          '202': { id: '202', status: 'sold', market_id: '7' },
        };
        return Promise.resolve(orders[String(payload.id)] ?? null);
      },
    );
  });

  it("ulanmagan chat — 'avval ulang', buyurtma umuman o'qilmaydi", async () => {
    const { ctx, replies } = makeCtx({ text: '/status 101', actor: null });

    await handler().handle(ctx as never);

    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(replies[0].text).toContain('avval Telegram');
  });

  it("ulangan market — o'z buyurtmasining holati", async () => {
    const { ctx, replies } = makeCtx({
      text: '/status 101',
      actor: marketActor('5'),
    });

    await handler().handle(ctx as never);

    expect(replies[0].text).toMatch(/#101[\s\S]*new/);
  });

  it("boshqa marketning buyurtmasi — 'topilmadi' (holat oshkor bo'lmaydi)", async () => {
    const { ctx, replies } = makeCtx({
      text: 'status 202',
      actor: marketActor('5'),
    });

    await handler().handle(ctx as never);

    expect(replies[0].text).toBe('❌ #202 buyurtma topilmadi.');
    expect(replies[0].text).not.toContain('sold');
  });

  it('kuryer/boshqa rol — /status rad etiladi, buyurtma o‘qilmaydi', async () => {
    const { ctx, replies } = makeCtx({
      text: '/status 101',
      actor: { ...marketActor('5'), role: 'courier', market_id: null },
    });

    await handler().handle(ctx as never);

    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(replies[0].text).toContain('faqat market');
  });

  it("eski { data } ko'rinishidagi javob ham o'qiladi", async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: { id: '101', status: 'received', market_id: 5 },
    });
    const { ctx, replies } = makeCtx({
      text: '/status 101',
      actor: marketActor('5'),
    });

    await handler().handle(ctx as never);

    expect(replies[0].text).toMatch(/#101[\s\S]*received/);
  });
});
