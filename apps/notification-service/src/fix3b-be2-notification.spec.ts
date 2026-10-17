import { RpcException } from '@nestjs/microservices';
import { TimeoutError } from 'rxjs';
import { NotificationServiceService } from './notification-service.service';
import { GroupHandler } from './bot/handlers/group.handler';
import { MarketHandler } from './bot/handlers/market.handler';
import { StartHandler } from './bot/handlers/start.handler';
import type { BotMessageHandler } from './bot/handlers/bot-context';
import {
  makeCtx,
  makeFetch,
  makeLinks,
  makeOutbox,
  marketActor,
} from './bot/testing/bot-kit-spec';

/**
 * fix3b BE-2 — Telegram botlari (hujjatlar bilan moslash):
 *
 *  - CODE-02 (B varianti): muvaffaqiyatli ulanishdan keyin market_tg_token
 *    ALMASHTIRILMAYDI (u order-bot kaliti bo'lib qoladi); mavjud
 *    (market, guruh turi) ulanishi bot/token orqali HECH QACHON
 *    almashtirilmaydi — faqat admin PATCH/DELETE /notifications/:id;
 *    ulash yo'lidagi qolgan inglizcha matnlar o'zbekcha;
 *    hujjatdagi `/id` (va `/id@<bot>`) komandasi → "Group ID: <chat.id>".
 *  - CODE-18: /status — mavjud bo'lmagan buyurtma (order-service 404 OTADI)
 *    va boshqa marketning buyurtmasi AYNI javobni oladi.
 * (ZlpXb4Wh) eski bot klasslari o'rniga bot/ yadrosi handlerlari; market
 * tokeni bilan shaxsiy chatda "kirish" OLIB TASHLANDI (aktor = telegram_id).
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
/** (6jXw0DDr) bir martalik guruh kodlari — matnli token o'rniga. */
const CODE = 'Q'.repeat(43);
const CANCEL_CODE = 'C'.repeat(43);
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
      {} as never,
      activityLog as never,
      makeOutbox(makeFetch()).outbox,
      makeLinks({
        [CODE]: { owner_id: '5', group_type: 'create' },
        [CANCEL_CODE]: { owner_id: '5', group_type: 'cancel' },
      }) as never,
    );
    routeIdentity({ id: '5', name: 'Beshinchi' });
  });

  it.each([
    ['CREATE', 'Q'.repeat(43), 'create'],
    ['CANCEL', 'C'.repeat(43), 'cancel'],
  ])(
    '%s guruhi ulanadi — identity.market.rotate_tg_token CHAQIRILMAYDI',
    async (_label, text, groupType) => {
      const res = await service.connectGroupByCodeText(text, '-100777');

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
        }),
      );
      // bOMYoOtV: token ustuni umuman yozilmaydi.
      expect(repo.create.mock.calls[0][0]).not.toHaveProperty('token');
      expect(cmdCalls('identity.market.rotate_tg_token')).toHaveLength(0);
    },
  );

  it.each([
    ['faol', true],
    ['nofaol', false],
  ])(
    '%s mavjud (market, tur) ulanishi kod bilan ham almashtirilmaydi',
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

      const res = await service.connectGroupByCodeText(CODE, '-100777');

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

    const res = await service.connectGroupByCodeText(CANCEL_CODE, '-100999');

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

    const res = await service.connectGroupByCodeText(CANCEL_CODE, '-100222');

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

    const res = await service.connectGroupByCodeText(CODE, '-100777');

    expect(res).toEqual(expect.objectContaining({ statusCode: 201 }));
  });

  it("market topilmasa — o'zbekcha 'Market topilmadi'", async () => {
    routeIdentity(null);

    const res = await service.connectGroupByCodeText(CODE, '-100777');

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

    const res = await service.connectGroupByCodeText(CODE, '-100777');

    expect(res).toEqual({
      message: 'Bu guruh shu xabar turi uchun allaqachon ulangan',
    });
  });

  it("kutilmagan baza xatosi matni guruhga YUBORILMAYDI — umumiy o'zbekcha xabar", async () => {
    repo.save.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "uq_tg"'),
    );

    const res = await service.connectGroupByCodeText(CODE, '-100777');

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

/** Router zanjiri (start → group → market): birinchi `true` qaytargan to'xtatadi. */
const makeChain = () => {
  const connectGroupByCodeText = jest.fn();
  const limiter = {
    linkAttempt: jest.fn(() =>
      Promise.resolve({ allowed: true, blocked: false, hits: 1 }),
    ),
  };
  const handlers: BotMessageHandler[] = [
    new StartHandler(
      limiter as never,
      { log: jest.fn() } as never,
      { get: jest.fn() } as never,
    ),
    new GroupHandler({ connectGroupByCodeText } as never, limiter as never),
    new MarketHandler({} as never),
  ];
  const run = async (
    text: string,
    options: { chatId?: string; chatType?: string; actor?: any } = {},
  ) => {
    const made = makeCtx({
      text,
      chatId: options.chatId ?? '-1001234',
      chatType: options.chatType ?? 'supergroup',
      actor: options.actor ?? null,
    });
    for (const handler of handlers) {
      if (await handler.handle(made.ctx as never)) break;
    }
    return made;
  };
  return { run, connectGroupByCodeText };
};

describe('fix3b CODE-02 — bot: /id va /help', () => {
  it.each(['/id', '/id@elchi_notify_bot', '  /id  '])(
    '%s → "Group ID: <chat.id>"',
    async (text) => {
      const chain = makeChain();

      const { replies } = await chain.run(text, { chatId: '-1001234567890' });

      expect(replies).toEqual([{ text: 'Group ID: -1001234567890' }]);
      expect(chain.connectGroupByCodeText).not.toHaveBeenCalled();
    },
  );

  it.each(['/id 123', '/identity', '/idx', 'id'])(
    '%s — /id komandasi emas, guruhda javob yo‘q',
    async (text) => {
      const { replies } = await makeChain().run(text);

      expect(replies).toHaveLength(0);
    },
  );

  it("/help — /id ni ko'rsatadi, token almashishi haqida eski gap yo'q", async () => {
    const { replies } = await makeChain().run('/help');

    const message = replies[0].text;
    expect(message).toContain('/id');
    expect(message).toContain('havola');
    expect(message).not.toContain('yangilanadi');
    expect(message).not.toContain('eskisi qayta ishlamaydi');
  });
});

describe('fix3b CODE-18 — /status: yo‘q va begona buyurtma bir xil javob', () => {
  const run = (text: string) =>
    makeChain().run(text, {
      chatId: '111',
      chatType: 'private',
      actor: marketActor('5'),
    });
  const replyOf = (made: { replies: Array<{ text: string }> }) =>
    made.replies[0]?.text;

  beforeEach(() => rmqSendMock.mockReset());

  it("boshqa marketning buyurtmasi va yo'q buyurtma (RMQ 404 obyekti) — AYNI javob", async () => {
    rmqSendMock.mockResolvedValueOnce({
      id: '202',
      status: 'sold',
      market_id: '7',
    });
    const foreign = await run('/status 202');

    rmqSendMock.mockRejectedValueOnce({
      statusCode: 404,
      message: 'Order #202 topilmadi',
    });
    const missing = await run('/status 202');

    expect(replyOf(foreign)).toBe('❌ #202 buyurtma topilmadi.');
    expect(replyOf(missing)).toBe(replyOf(foreign));
  });

  it("lokal RpcException 404 ham — 'topilmadi'", async () => {
    rmqSendMock.mockRejectedValueOnce(
      new RpcException({ statusCode: 404, message: 'Order #9 topilmadi' }),
    );

    expect(replyOf(await run('status 9'))).toBe('❌ #9 buyurtma topilmadi.');
  });

  it("timeout — o'zbekcha umumiy xabar, inglizcha xato matni chatga ketmaydi", async () => {
    rmqSendMock.mockRejectedValueOnce(new TimeoutError());

    const made = await run('/status 101');

    expect(replyOf(made)).toBe(
      "❌ Buyurtmani olishda xatolik. Birozdan so'ng qayta urinib ko'ring.",
    );
    expect(replyOf(made)).not.toMatch(/Timeout/i);
  });

  it("500 xato 'topilmadi' deb ko'rsatilmaydi (holat yashirilmaydi, lekin oshkor ham qilinmaydi)", async () => {
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 500,
      message: 'relation "orders" does not exist',
    });

    expect(replyOf(await run('/status 101'))).toBe(
      "❌ Buyurtmani olishda xatolik. Birozdan so'ng qayta urinib ko'ring.",
    );
  });

  it("o'z buyurtmasi — holat ko'rsatiladi (o'zgarmagan)", async () => {
    rmqSendMock.mockResolvedValueOnce({
      id: '101',
      status: 'waiting',
      market_id: '5',
    });

    expect(replyOf(await run('/status 101'))).toMatch(/#101[\s\S]*waiting/);
  });

  it('(ZlpXb4Wh #3) market tokeni shaxsiy chatda endi "kirish" EMAS — identity so‘ralmaydi', async () => {
    const made = await makeChain().run(SECRET, {
      chatId: '222',
      chatType: 'private',
    });

    expect(rmqSendMock).not.toHaveBeenCalled();
    // Hech bir handler olmaydi — router umumiy "tushunarsiz" javobini beradi.
    expect(made.replies).toHaveLength(0);
  });
});
