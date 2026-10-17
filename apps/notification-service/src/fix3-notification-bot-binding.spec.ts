import { NotificationServiceService } from './notification-service.service';
import { GroupHandler } from './bot/handlers/group.handler';
import { MarketHandler } from './bot/handlers/market.handler';
import {
  ENV_BOT_TOKEN,
  makeCtx,
  makeFetch,
  makeLinks,
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
/** Bir martalik guruh kodlari (43 belgi, base64url). */
const CODE = 'Q'.repeat(43);
const CANCEL_CODE = 'C'.repeat(43);
const USER_CODE = 'U'.repeat(43);
const EXPIRED_CODE = 'E'.repeat(43);

const cmdCalls = (cmd: string) =>
  rmqSendMock.mock.calls.filter(([, pattern]) => pattern?.cmd === cmd);

describe('6jXw0DDr / CODE-02: guruhni ulash faqat BIR MARTALIK kod bilan', () => {
  let service: NotificationServiceService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let fetchMock: ReturnType<typeof makeFetch>;
  let links: ReturnType<typeof makeLinks>;

  beforeEach(() => {
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }, payload: any) =>
        pattern.cmd === 'identity.market.find_by_id'
          ? Promise.resolve({
              success: true,
              data: { id: String(payload.id), name: 'Beshinchi' },
            })
          : Promise.resolve(null),
    );
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
    links = makeLinks({
      [CODE]: { owner_id: '5', group_type: 'create', created_by: '37' },
      [CANCEL_CODE]: { owner_id: '5', group_type: 'cancel' },
      [USER_CODE]: { owner_id: '25', purpose: 'user' },
      [EXPIRED_CODE]: { owner_id: '5', status: 'expired' },
    });
    service = new NotificationServiceService(
      repo as never,
      {} as never,
      activityLog as never,
      makeOutbox(fetchMock).outbox,
      links as never,
    );
  });

  it.each([
    'group_token-5',
    'group_token-5-create',
    'group_token-5-cancel',
    'GROUP_TOKEN-12',
    SECRET,
    `${SECRET}-cancel`,
  ])(
    '⭐ %s — matnli token (raqamli ham, uzoq yashovchi market tokeni ham) rad etiladi, hech narsa yozilmaydi',
    async (text) => {
      const res = await service.connectGroupByCodeText(text, '-100777');

      expect(res).toEqual({
        message: expect.stringContaining('Ulash kodi noto'),
      });
      expect(rmqSendMock).not.toHaveBeenCalled();
      expect(cmdCalls('identity.market.find_by_tg_token')).toHaveLength(0);
      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it('⭐ bir martalik kod — CREATE guruhi ulanadi, token saqlanmaydi, market tokeni aylanmaydi', async () => {
    const res = await service.connectGroupByCodeText(CODE, '-100777');

    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 201,
        message: 'Beshinchi uchun Telegram guruhi ulandi',
      }),
    );
    expect(links.claim).toHaveBeenCalledWith(CODE, 'group', '-100777');
    // bOMYoOtV: token ustuni umuman yozilmaydi (bot tokeni faqat env).
    expect(repo.create).toHaveBeenCalledWith({
      market_id: '5',
      group_id: '-100777',
      group_type: 'create',
      is_active: true,
    });
    expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
    expect(JSON.stringify(repo.save.mock.calls)).not.toContain(CODE);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_group_connected',
        metadata: expect.objectContaining({ linked_by: '37' }),
      }),
    );
  });

  it('cancel kodi — CANCEL guruhi', async () => {
    const res = await service.connectGroupByCodeText(CANCEL_CODE, '-100888');

    expect(res).toEqual(expect.objectContaining({ statusCode: 201 }));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ group_type: 'cancel' }),
    );
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('token');
  });

  it('⭐ ishlatilgan kod ikkinchi marta — rad, guruh ulanmaydi', async () => {
    await service.connectGroupByCodeText(CODE, '-100777');
    repo.save.mockClear();
    const second = await service.connectGroupByCodeText(CODE, '-100999');
    expect(second).toEqual({
      message: expect.stringContaining('allaqachon ishlatilgan'),
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('⭐ muddati o‘tgan kod — rad', async () => {
    const res = await service.connectGroupByCodeText(EXPIRED_CODE, '-100777');
    expect(res).toEqual({ message: expect.stringContaining('eskirgan') });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('shaxsiy (user) kod guruhda — rad', async () => {
    const res = await service.connectGroupByCodeText(USER_CODE, '-100777');
    expect(res).toEqual({ message: expect.stringContaining('shaxsiy chat') });
  });

  it('⭐ mavjud (market, tur) ulanishi kod bilan ham ALMASHTIRILMAYDI (boshqa guruh marketni tortib ololmaydi)', async () => {
    const existing = {
      id: '41',
      market_id: '5',
      group_id: '-100111',
      group_type: 'create',
      is_active: true,
    };
    repo.findOne
      .mockResolvedValueOnce(null) // existsByGroup
      .mockResolvedValueOnce(existing); // existsByMarketType

    const res = await service.connectGroupByCodeText(CODE, '-100777');

    expect(res).toEqual({
      message:
        "Bu market uchun bu turdagi guruh allaqachon ulangan — admin orqali o'zgartiring",
    });
    expect(repo.save).not.toHaveBeenCalled();
    expect(existing.group_id).toBe('-100111');
  });

  it('guruh allaqachon ulangan bo‘lsa — rad etiladi (fix3b: xabar o‘zbekcha)', async () => {
    repo.findOne.mockResolvedValueOnce({ id: '9', group_id: '-100777' });

    const res = await service.connectGroupByCodeText(CODE, '-100777');

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
  it.each(['/start', '/help'])(
    '%s (guruh) — faqat kabinet havolasiga yo‘naltiradi',
    async (command) => {
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
      expect(message).toContain('havola');
      expect(message).not.toMatch(/group_token/);
      expect(message).not.toContain('marketId');
    },
  );
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
