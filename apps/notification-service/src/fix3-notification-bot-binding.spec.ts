import { NotificationServiceService } from './notification-service.service';
import { NotificationBotUpdateService } from './notification-bot.update';
import { OrderBotUpdateService } from './order-bot.update';

/**
 * FIX3 (A7):
 *  - CODE-02: notification bot guruhni FAQAT marketning joriy maxfiy
 *    market_tg_token'i bilan ulaydi — `group_token-<marketId>` yorlig'i va
 *    saqlangan eski token bo'yicha zaxira yo'q; /start va /help id formatini
 *    reklama qilmaydi; maxfiy token bazada saqlanmaydi va bot tokeni sifatida
 *    ishlatilmaydi; fix3b: token ulangandan keyin ALMASHTIRILMAYDI va mavjud
 *    (market, tur) ulanishi bot orqali almashtirilmaydi;
 *  - CODE-18: order-bot /status faqat ulangan chatga va faqat o'sha marketning
 *    buyurtmasi uchun javob beradi.
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
    service = new NotificationServiceService(
      repo as never,
      {
        get: jest.fn((key: string) =>
          key === 'TELEGRAM_BOT_TOKEN' ? 'ENV_TOKEN' : undefined,
        ),
      } as never,
      {} as never,
      activityLog as never,
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
    expect(repo.create).toHaveBeenCalledWith({
      market_id: '5',
      group_id: '-100777',
      group_type: 'create',
      token: null,
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
      expect.objectContaining({ group_type: 'cancel', token: null }),
    );
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

  describe('yuborish: market tokeni bot tokeni sifatida ishlatilmaydi', () => {
    const okFetch = () =>
      jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
      });

    it('eski qatordagi group_token-… e’tiborsiz — env bot yuboradi', async () => {
      const fetchMock = okFetch();
      (global as any).fetch = fetchMock;
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
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.telegram.org/botENV_TOKEN/sendMessage',
      );
    });

    it('qatorda haqiqiy bot tokeni bo‘lsa — o‘sha ishlatiladi (o‘zgarmagan)', async () => {
      const fetchMock = okFetch();
      (global as any).fetch = fetchMock;
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

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.telegram.org/bot123456:REAL_BOT/sendMessage',
      );
    });
  });
});

describe('CODE-02: /start va /help market id formatini ko‘rsatmaydi', () => {
  it.each(['/start', '/help'])('%s', async (command) => {
    const sendDirectToGroup = jest.fn().mockResolvedValue({ success: true });
    const bot = new NotificationBotUpdateService({
      sendDirectToGroup,
      connectGroupByTokenText: jest.fn(),
    } as never);

    await (
      bot as unknown as { processUpdate: (u: unknown) => Promise<void> }
    ).processUpdate({
      update_id: 1,
      message: { chat: { id: -100777 }, text: command },
    });

    const message = String(sendDirectToGroup.mock.calls[0][0].message);
    expect(message).toContain('maxfiy market token');
    expect(message).not.toMatch(/group_token-\d/);
    expect(message).not.toContain('marketId');
  });
});

describe('CODE-18: order-bot /status faqat o‘z marketi uchun', () => {
  interface BotInternals {
    links: Map<string, { id: string; name: string; token: string }>;
    orderClient: unknown;
    identityClient: unknown;
    sendMessage: jest.Mock;
    answerCallback: jest.Mock;
    processUpdate: (update: unknown) => Promise<void>;
  }

  const make = (): BotInternals => {
    const svc = Object.create(OrderBotUpdateService.prototype) as BotInternals;
    svc.links = new Map();
    svc.orderClient = {};
    svc.identityClient = {};
    svc.sendMessage = jest.fn().mockResolvedValue(undefined);
    svc.answerCallback = jest.fn().mockResolvedValue(undefined);
    return svc;
  };

  const text = (chat: number, value: string) => ({
    update_id: 1,
    message: { chat: { id: chat }, text: value },
  });

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

  it("ulanmagan chat — token so'raladi, buyurtma umuman o'qilmaydi", async () => {
    const svc = make();

    await svc.processUpdate(text(111, '/status 101'));

    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(svc.sendMessage).toHaveBeenCalledWith(
      '111',
      expect.stringContaining('avval market tokeningizni yuboring'),
    );
  });

  it("ulangan chat — o'z buyurtmasining holati", async () => {
    const svc = make();
    svc.links.set('111', { id: '5', name: 'Beshinchi', token: SECRET });

    await svc.processUpdate(text(111, '/status 101'));

    expect(svc.sendMessage).toHaveBeenCalledWith(
      '111',
      expect.stringMatching(/#101[\s\S]*new/),
    );
  });

  it("boshqa marketning buyurtmasi — 'topilmadi' (holat oshkor bo'lmaydi)", async () => {
    const svc = make();
    svc.links.set('111', { id: '5', name: 'Beshinchi', token: SECRET });

    await svc.processUpdate(text(111, 'status 202'));

    expect(svc.sendMessage).toHaveBeenCalledWith(
      '111',
      '❌ #202 buyurtma topilmadi.',
    );
    expect(String(svc.sendMessage.mock.calls[0][1])).not.toContain('sold');
  });

  it("callback 'status:<id>' ham ulangan chatni talab qiladi", async () => {
    const svc = make();

    await svc.processUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb1',
        data: 'status:101',
        message: { chat: { id: 333 } },
      },
    });

    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(svc.sendMessage).toHaveBeenCalledWith(
      '333',
      expect.stringContaining('avval market tokeningizni yuboring'),
    );
  });

  it("eski { data } ko'rinishidagi javob ham o'qiladi", async () => {
    const svc = make();
    svc.links.set('111', { id: '5', name: 'Beshinchi', token: SECRET });
    rmqSendMock.mockResolvedValueOnce({
      data: { id: '101', status: 'received', market_id: 5 },
    });

    await svc.processUpdate(text(111, '/status 101'));

    expect(svc.sendMessage).toHaveBeenCalledWith(
      '111',
      expect.stringMatching(/#101[\s\S]*received/),
    );
  });
});
