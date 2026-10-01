import { RpcException } from '@nestjs/microservices';
import { TimeoutError } from 'rxjs';
import { NotificationServiceService } from './notification-service.service';
import { NotificationBotUpdateService } from './notification-bot.update';
import { OrderBotUpdateService } from './order-bot.update';

/**
 * fix3b BE-2 — Telegram botlari (hujjatlar bilan moslash):
 *
 *  - CODE-02 (B varianti): muvaffaqiyatli ulanishdan keyin market_tg_token
 *    ALMASHTIRILMAYDI (u order-bot kaliti bo'lib qoladi); mavjud
 *    (market, guruh turi) ulanishi bot/token orqali HECH QACHON
 *    almashtirilmaydi — faqat admin PATCH/DELETE /notifications/:id;
 *    ulash yo'lidagi qolgan inglizcha matnlar o'zbekcha;
 *    hujjatdagi `/id` (va `/id@<bot>`) komandasi → "Group ID: <chat.id>".
 *  - CODE-18: order-bot /status — mavjud bo'lmagan buyurtma (order-service
 *    404 OTADI) va boshqa marketning buyurtmasi AYNI javobni oladi.
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
const MARKET_TAKEN =
  "Bu market uchun bu turdagi guruh allaqachon ulangan — admin orqali o'zgartiring";

const cmdCalls = (cmd: string) =>
  rmqSendMock.mock.calls.filter(
    ([, pattern]) => (pattern as { cmd?: string } | undefined)?.cmd === cmd,
  );

describe('fix3b CODE-02 — ulash: token almashtirilmaydi, mavjud ulanish almashtirilmaydi', () => {
  let service: NotificationServiceService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let activityLog: { log: jest.Mock; logChange: jest.Mock };

  /** Saqlangan qatorlar: (market_id, group_type, group_id). */
  let rows: Array<Record<string, unknown>>;

  const routeIdentity = (marketById: Record<string, unknown> | null) =>
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
            return Promise.resolve(
              marketById ? { success: true, data: marketById } : null,
            );
          case 'identity.market.rotate_tg_token':
            return Promise.resolve({ statusCode: 200 });
          default:
            return Promise.resolve(null);
        }
      },
    );

  beforeEach(() => {
    rmqSendMock.mockReset();
    rows = [];
    repo = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.find((row) =>
            Object.entries(where).every(([key, value]) =>
              key === 'isDeleted'
                ? row.isDeleted === value
                : String(row[key]) === String(value),
            ),
          ) ?? null,
        ),
      ),
      find: jest.fn(),
      findAndCount: jest.fn(),
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
      { get: jest.fn(() => 'ENV_TOKEN') } as never,
      {} as never,
      activityLog as never,
    );
    routeIdentity({ id: '5', name: 'Beshinchi' });
  });

  it.each([
    ['CREATE', SECRET, 'create'],
    ['CANCEL', `${SECRET}-cancel`, 'cancel'],
  ])(
    '%s guruhi ulanadi — identity.market.rotate_tg_token CHAQIRILMAYDI',
    async (_label, text, groupType) => {
      const res = await service.connectGroupByTokenText(text, '-100777');

      expect(res).toEqual(
        expect.objectContaining({
          statusCode: 201,
          message: 'Beshinchi uchun Telegram guruhi ulandi',
        }),
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          market_id: '5',
          group_id: '-100777',
          group_type: groupType,
          token: null,
        }),
      );
      expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
    },
  );

  it.each([
    ['faol', true],
    ['nofaol', false],
  ])(
    '%s mavjud (market, tur) ulanishi joriy token bilan ham almashtirilmaydi',
    async (_label, isActive) => {
      const existing = {
        id: '41',
        market_id: '5',
        group_id: '-100111',
        group_type: 'create',
        token: null,
        is_active: isActive,
        isDeleted: false,
      };
      rows = [existing];

      const res = await service.connectGroupByTokenText(SECRET, '-100777');

      expect(res).toEqual({ message: MARKET_TAKEN });
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(existing).toEqual(
        expect.objectContaining({ group_id: '-100111', is_active: isActive }),
      );
      expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
      expect(activityLog.log).not.toHaveBeenCalled();
    },
  );

  it('POST /notifications/connect-by-token (o‘sha funksiya) ham almashtirmaydi', async () => {
    rows = [
      {
        id: '41',
        market_id: '5',
        group_id: '-100111',
        group_type: 'cancel',
        isDeleted: false,
      },
    ];

    const res = await service.connectGroupByTokenText(
      `${SECRET}-cancel`,
      '-100999',
    );

    expect(res).toEqual({ message: MARKET_TAKEN });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('CREATE ulangan bo‘lsa ham CANCEL turini alohida ulash mumkin', async () => {
    rows = [
      {
        id: '41',
        market_id: '5',
        group_id: '-100111',
        group_type: 'create',
        isDeleted: false,
      },
    ];

    const res = await service.connectGroupByTokenText(
      `${SECRET}-cancel`,
      '-100222',
    );

    expect(res).toEqual(expect.objectContaining({ statusCode: 201 }));
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ group_type: 'cancel', group_id: '-100222' }),
    );
  });

  it("o'chirilgan (isDeleted) ulanish to'siq emas — qayta ulash mumkin", async () => {
    rows = [
      {
        id: '40',
        market_id: '5',
        group_id: '-100111',
        group_type: 'create',
        isDeleted: true,
      },
    ];

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual(expect.objectContaining({ statusCode: 201 }));
  });

  it("market topilmasa — o'zbekcha 'Market topilmadi'", async () => {
    routeIdentity(null);

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual({ message: 'Market topilmadi' });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('guruh shu tur uchun boshqa marketga ulangan — o‘zbekcha xabar', async () => {
    rows = [
      {
        id: '9',
        market_id: '7',
        group_id: '-100777',
        group_type: 'create',
        isDeleted: false,
      },
    ];

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual({
      message: 'Bu guruh shu xabar turi uchun allaqachon ulangan',
    });
  });

  it("kutilmagan baza xatosi matni guruhga YUBORILMAYDI — umumiy o'zbekcha xabar", async () => {
    repo.save.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "uq_tg"'),
    );

    const res = await service.connectGroupByTokenText(SECRET, '-100777');

    expect(res).toEqual({
      message:
        "Guruhni ulashda xatolik yuz berdi — birozdan so'ng qayta urinib ko'ring",
    });
    expect(JSON.stringify(res)).not.toContain('duplicate key');
  });

  it("market_id raqam bo'lmasa — o'zbekcha xabar (RpcException 400)", async () => {
    const error = await service
      .findAllTelegramMarkets({ market_id: 'abc' })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual({
      statusCode: 400,
      message: "market_id noto'g'ri — faqat raqam (bigint) bo'lishi kerak",
    });
  });
});

describe('fix3b CODE-02 — notification bot: /id va /help', () => {
  const makeBot = () => {
    const sendDirectToGroup = jest.fn().mockResolvedValue({ success: true });
    const connectGroupByTokenText = jest.fn();
    const bot = new NotificationBotUpdateService({
      sendDirectToGroup,
      connectGroupByTokenText,
    } as never);
    const processUpdate = (text: string, chatId: number | string = -1001234) =>
      (
        bot as unknown as { processUpdate: (u: unknown) => Promise<void> }
      ).processUpdate({
        update_id: 1,
        message: { chat: { id: chatId }, text },
      });
    return { sendDirectToGroup, connectGroupByTokenText, processUpdate };
  };

  it.each(['/id', '/id@elchi_notify_bot', '  /id  '])(
    '%s → "Group ID: <chat.id>"',
    async (text) => {
      const bot = makeBot();

      await bot.processUpdate(text, -1001234567890);

      expect(bot.sendDirectToGroup).toHaveBeenCalledTimes(1);
      expect(bot.sendDirectToGroup).toHaveBeenCalledWith({
        group_id: '-1001234567890',
        message: 'Group ID: -1001234567890',
      });
      expect(bot.connectGroupByTokenText).not.toHaveBeenCalled();
    },
  );

  it.each(['/id 123', '/identity', '/idx', 'id'])(
    '%s — /id komandasi emas, javob yo‘q',
    async (text) => {
      const bot = makeBot();

      await bot.processUpdate(text);

      expect(bot.sendDirectToGroup).not.toHaveBeenCalled();
    },
  );

  it("/help — /id ni ko'rsatadi, token almashishi haqida eski gap yo'q", async () => {
    const bot = makeBot();

    await bot.processUpdate('/help');

    const message = String(
      (bot.sendDirectToGroup.mock.calls[0][0] as { message: string }).message,
    );
    expect(message).toContain('/id');
    expect(message).toContain('maxfiy market token');
    expect(message).not.toContain('yangilanadi');
    expect(message).not.toContain('eskisi qayta ishlamaydi');
  });
});

describe('fix3b CODE-18 — order-bot /status: yo‘q va begona buyurtma bir xil javob', () => {
  interface BotInternals {
    links: Map<string, { id: string; name: string; token: string }>;
    orderClient: unknown;
    identityClient: unknown;
    logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
    sendMessage: jest.Mock;
    answerCallback: jest.Mock;
    processUpdate: (update: unknown) => Promise<void>;
  }

  const make = (): BotInternals => {
    const svc = Object.create(OrderBotUpdateService.prototype) as BotInternals;
    svc.links = new Map([
      ['111', { id: '5', name: 'Beshinchi', token: SECRET }],
    ]);
    svc.orderClient = {};
    svc.identityClient = {};
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    svc.sendMessage = jest.fn().mockResolvedValue(undefined);
    svc.answerCallback = jest.fn().mockResolvedValue(undefined);
    return svc;
  };

  const text = (value: string, chat = 111) => ({
    update_id: 1,
    message: { chat: { id: chat }, text: value },
  });

  const replyOf = (svc: BotInternals) =>
    String(svc.sendMessage.mock.calls[0]?.[1]);

  beforeEach(() => rmqSendMock.mockReset());

  it("boshqa marketning buyurtmasi va yo'q buyurtma (RMQ 404 obyekti) — AYNI javob", async () => {
    const foreign = make();
    rmqSendMock.mockResolvedValueOnce({
      id: '202',
      status: 'sold',
      market_id: '7',
    });
    await foreign.processUpdate(text('/status 202'));

    const missing = make();
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 404,
      message: 'Order #202 topilmadi',
    });
    await missing.processUpdate(text('/status 202'));

    expect(replyOf(foreign)).toBe('❌ #202 buyurtma topilmadi.');
    expect(replyOf(missing)).toBe(replyOf(foreign));
  });

  it("lokal RpcException 404 ham — 'topilmadi'", async () => {
    const svc = make();
    rmqSendMock.mockRejectedValueOnce(
      new RpcException({ statusCode: 404, message: 'Order #9 topilmadi' }),
    );

    await svc.processUpdate(text('status 9'));

    expect(replyOf(svc)).toBe('❌ #9 buyurtma topilmadi.');
  });

  it("callback 'status:<id>' yo'li ham 404 da 'topilmadi'", async () => {
    const svc = make();
    rmqSendMock.mockRejectedValueOnce({ statusCode: 404, message: 'x' });

    await svc.processUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb1',
        data: 'status:303',
        message: { chat: { id: 111 } },
      },
    });

    expect(svc.sendMessage).toHaveBeenCalledWith(
      '111',
      '❌ #303 buyurtma topilmadi.',
    );
  });

  it("timeout — o'zbekcha umumiy xabar, inglizcha xato matni chatga ketmaydi", async () => {
    const svc = make();
    rmqSendMock.mockRejectedValueOnce(new TimeoutError());

    await svc.processUpdate(text('/status 101'));

    expect(replyOf(svc)).toBe(
      "❌ Buyurtmani olishda xatolik. Birozdan so'ng qayta urinib ko'ring.",
    );
    expect(replyOf(svc)).not.toMatch(/Timeout/i);
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it("500 xato 'topilmadi' deb ko'rsatilmaydi (holat yashirilmaydi, lekin oshkor ham qilinmaydi)", async () => {
    const svc = make();
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 500,
      message: 'relation "orders" does not exist',
    });

    await svc.processUpdate(text('/status 101'));

    expect(replyOf(svc)).toBe(
      "❌ Buyurtmani olishda xatolik. Birozdan so'ng qayta urinib ko'ring.",
    );
  });

  it("o'z buyurtmasi — holat ko'rsatiladi (o'zgarmagan)", async () => {
    const svc = make();
    rmqSendMock.mockResolvedValueOnce({
      id: '101',
      status: 'waiting',
      market_id: '5',
    });

    await svc.processUpdate(text('/status 101'));

    expect(replyOf(svc)).toMatch(/#101[\s\S]*waiting/);
  });

  describe('token yuborish (handleToken)', () => {
    it("identity 404 (noma'lum token) → \"Token noto'g'ri yoki market topilmadi\"", async () => {
      const svc = make();
      svc.links.clear();
      rmqSendMock.mockRejectedValueOnce({
        statusCode: 404,
        message: 'Market topilmadi yoki token noto‘g‘ri',
      });

      await svc.processUpdate(text(SECRET, 222));

      expect(svc.sendMessage).toHaveBeenCalledWith(
        '222',
        "❌ Token noto'g'ri yoki market topilmadi.",
      );
      expect(svc.links.has('222')).toBe(false);
    });

    it("timeout → o'zbekcha umumiy xabar, inglizcha matnsiz", async () => {
      const svc = make();
      rmqSendMock.mockRejectedValueOnce(new TimeoutError());

      await svc.processUpdate(text(SECRET, 222));

      expect(svc.sendMessage).toHaveBeenCalledWith(
        '222',
        "❌ Token tekshirishda xatolik. Birozdan so'ng qayta urinib ko'ring.",
      );
      expect(svc.links.has('222')).toBe(false);
    });
  });
});
