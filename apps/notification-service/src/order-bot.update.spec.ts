import { OrderBotUpdateService } from './order-bot.update';

/**
 * Order bot — per-chat navbat (Gy8Lt6KT #8-#11, BeePost ai-queue.spec.ts
 * uslubida). Kafolatlar:
 *  - pollLoop ishlov berishni KUTMAYDI: A chatning 15 s lik ishi B chatni
 *    bloklamaydi (#8);
 *  - throw bo'lsa bir marta qayta urinish, ikkinchi xatoda ERROR va to'xtash;
 *    offset baribir oshadi, cheksiz sikl yo'q (#9);
 *  - navbat 12 ta bilan cheklangan, 13-si rad etiladi va foydalanuvchiga
 *    javob boradi — jimgina tashlanmaydi (#10);
 *  - bitta ish throw qilsa keyingilari baribir bajariladi (#11);
 *  - bitta chat ichida qat'iy FIFO;
 *  - onModuleDestroy polling'ni to'xtatadi va navbatni ko'pi bilan 8 s kutadi.
 */

const rmqSendMock = jest.fn();

// order-bot.update.ts `@app/common` dan faqat rmqSend oladi — butun barrel'ni
// yuklamaslik uchun yengil mock.
jest.mock('@app/common', () => ({
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

interface TestUpdate {
  update_id: number;
  message?: { chat?: { id: number | string }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number | string };
    message?: { chat?: { id: number | string } };
  };
}

/** Konstruktorni chetlab o'tib ochilgan ichki holat (BeePost `make()` uslubi). */
interface BotInternals {
  offset: number;
  running: boolean;
  timer: NodeJS.Timeout | null;
  token: string;
  webAppUrl: string;
  links: Map<string, unknown>;
  identityClient: unknown;
  orderClient: unknown;
  logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  chatQueues: Map<string, Promise<void>>;
  chatPending: Map<string, number>;
  sendMessage: jest.Mock<Promise<void>, [string, string, unknown?]>;
  scheduleNext: jest.Mock;
  processUpdate: (update: TestUpdate) => Promise<void>;
  enqueueChat(chatId: string, task: () => Promise<void>): boolean;
  processWithRetry(update: TestUpdate): Promise<void>;
  pollLoop(): Promise<void>;
  onModuleDestroy(): Promise<void>;
}

const QUEUE_FULL_TEXT =
  "Juda ko'p xabar navbatda. Avvalgilarini o'qib bo'lay, biroz kuting.";

const make = (): BotInternals => {
  // Konstruktorni chetlab o'tamiz — instance maydonlarni qo'lda beramiz.
  const svc = Object.create(OrderBotUpdateService.prototype) as BotInternals;
  svc.offset = 0;
  svc.running = true;
  svc.timer = null;
  svc.token = 'TEST_BOT_TOKEN';
  svc.webAppUrl = '';
  svc.links = new Map();
  svc.identityClient = {};
  svc.orderClient = {};
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.chatQueues = new Map();
  svc.chatPending = new Map();
  // Telegram'ga haqiqiy so'rov ketmasin; keyingi poll rejalashtirilmasin.
  svc.sendMessage = jest.fn<Promise<void>, [string, string, unknown?]>(() =>
    Promise.resolve(),
  );
  svc.scheduleNext = jest.fn();
  return svc;
};

const textUpdate = (
  updateId: number,
  chatId: number | string,
  text: string,
): TestUpdate => ({
  update_id: updateId,
  message: { chat: { id: chatId }, text },
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const originalFetch = global.fetch;
let fetchMock: jest.Mock<Promise<unknown>, [string, unknown?]>;

/** getUpdates javobini (bitta partiya) qaytaradigan fetch mock'i. */
const mockGetUpdates = (updates: TestUpdate[]) => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, result: updates }),
  });
};

const drain = async (svc: BotInternals) => {
  await Promise.allSettled([...svc.chatQueues.values()]);
};

beforeEach(() => {
  jest.useFakeTimers();
  rmqSendMock.mockReset();
  fetchMock = jest.fn<Promise<unknown>, [string, unknown?]>();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
});

describe('OrderBotUpdateService — per-chat navbat (Gy8Lt6KT)', () => {
  it('#8: A chatning 15 s lik ishi davomida B chat darhol javob oladi', async () => {
    const svc = make();
    // A: `/status 101` — buyurtma so'rovi 15 s "osilib" turadi.
    rmqSendMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ data: { id: '101', status: 'new' } }),
            15_000,
          ),
        ),
    );
    mockGetUpdates([
      textUpdate(10, 111, '/status 101'),
      textUpdate(11, 222, '/start'),
    ]);

    // pollLoop ishlov berishni kutmaydi — darhol qaytadi.
    await svc.pollLoop();
    expect(svc.offset).toBe(12);
    expect(svc.scheduleNext).toHaveBeenCalledWith(200);

    await jest.advanceTimersByTimeAsync(0);
    // B allaqachon javob oldi, A esa hali ham ishlayapti.
    expect(svc.sendMessage).toHaveBeenCalledTimes(1);
    expect(svc.sendMessage).toHaveBeenCalledWith(
      '222',
      expect.stringContaining('Buyurtma yaratish boti'),
    );
    expect(svc.chatPending.get('111')).toBe(1);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(svc.sendMessage).toHaveBeenCalledTimes(2);
    expect(svc.sendMessage.mock.calls[0][0]).toBe('222');
    expect(svc.sendMessage.mock.calls[1][0]).toBe('111');
    expect(svc.sendMessage.mock.calls[1][1]).toContain('#101');
    expect(svc.chatQueues.size).toBe(0);
    expect(svc.chatPending.size).toBe(0);
  });

  it('#8: chat id callback_query.message.chat.id yoki from.id dan olinadi', async () => {
    const svc = make();
    const seen: string[] = [];
    svc.processUpdate = async (update: TestUpdate) => {
      await sleep(10);
      seen.push(String(update.update_id));
    };
    mockGetUpdates([
      {
        update_id: 1,
        callback_query: { id: 'cb1', message: { chat: { id: 555 } } },
      },
      { update_id: 2, callback_query: { id: 'cb2', from: { id: 777 } } },
    ]);
    await svc.pollLoop();
    // Ikki xil chat — ikki alohida navbat, ikkalasi parallel ishlaydi.
    expect([...svc.chatPending.keys()].sort()).toEqual(['555', '777']);
    await jest.advanceTimersByTimeAsync(10);
    expect(seen.sort()).toEqual(['1', '2']);
    expect(svc.chatPending.size).toBe(0);
  });

  describe("#9: processUpdate throw — bir marta qayta urinish, cheksiz sikl yo'q", () => {
    it("bir marta yiqilsa — 2 chaqiruv, ERROR yo'q", async () => {
      const svc = make();
      const processUpdate = jest
        .fn()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValueOnce(undefined);
      svc.processUpdate = processUpdate;

      await svc.processWithRetry(textUpdate(41, 111, 'salom'));

      expect(processUpdate).toHaveBeenCalledTimes(2);
      expect(svc.logger.warn).toHaveBeenCalledTimes(1);
      expect(svc.logger.error).not.toHaveBeenCalled();
    });

    it('ikki marta yiqilsa — AYNAN 2 chaqiruv + ERROR, throw qilmaydi', async () => {
      const svc = make();
      const processUpdate = jest.fn().mockRejectedValue(new Error('poison'));
      svc.processUpdate = processUpdate;

      await expect(
        svc.processWithRetry(textUpdate(42, 111, 'salom')),
      ).resolves.toBeUndefined();

      expect(processUpdate).toHaveBeenCalledTimes(2);
      expect(svc.logger.error).toHaveBeenCalledTimes(1);
      expect(svc.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Update 42 failed twice'),
      );
    });

    it('pollLoop orqali: offset baribir oshadi va keyingi poll undan davom etadi', async () => {
      const svc = make();
      const processUpdate = jest.fn().mockRejectedValue(new Error('poison'));
      svc.processUpdate = processUpdate;
      mockGetUpdates([textUpdate(42, 111, 'salom')]);

      await svc.pollLoop();
      expect(svc.offset).toBe(43);

      await drain(svc);
      expect(processUpdate).toHaveBeenCalledTimes(2);
      expect(svc.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Update 42 failed twice'),
      );
      expect(svc.chatQueues.size).toBe(0);
      expect(svc.chatPending.size).toBe(0);

      // Keyingi getUpdates 43 dan so'raydi — o'sha update QAYTA kelmaydi.
      mockGetUpdates([]);
      await svc.pollLoop();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain('offset=43');
      expect(processUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('#10: navbat 12 ta bilan cheklangan', () => {
    it('12 ta sekin ish qabul, 13-si false; boshqa chat navbati alohida', async () => {
      const svc = make();
      const slow = () => sleep(1_000);
      const accepted: boolean[] = [];
      for (let i = 0; i < 12; i++) accepted.push(svc.enqueueChat('7', slow));
      expect(accepted.every((x) => x)).toBe(true);
      expect(svc.enqueueChat('7', slow)).toBe(false);
      // Boshqa chat to'lmagan — qabul qilinadi.
      expect(svc.enqueueChat('8', slow)).toBe(true);

      await jest.advanceTimersByTimeAsync(12_000);
      expect(svc.chatQueues.size).toBe(0);
      expect(svc.chatPending.size).toBe(0);
      // Bo'shagach yana qabul qiladi.
      expect(svc.enqueueChat('7', slow)).toBe(true);
      await jest.advanceTimersByTimeAsync(1_000);
    });

    it('13-update rad etiladi va foydalanuvchiga "navbatda" javobi boradi', async () => {
      const svc = make();
      const processUpdate = jest.fn(() => sleep(1_000));
      svc.processUpdate = processUpdate;
      const updates = Array.from({ length: 13 }, (_, i) =>
        textUpdate(100 + i, 333, `buyurtma ${i}`),
      );
      mockGetUpdates(updates);

      await svc.pollLoop();

      // Offset hammasi uchun oshdi, 13-si jimgina tashlanmadi — javob ketdi.
      expect(svc.offset).toBe(113);
      expect(svc.sendMessage).toHaveBeenCalledTimes(1);
      expect(svc.sendMessage).toHaveBeenCalledWith(
        '333',
        expect.stringContaining(QUEUE_FULL_TEXT),
      );
      expect(svc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('update 112 rejected'),
      );
      expect(svc.chatPending.get('333')).toBe(12);

      await jest.advanceTimersByTimeAsync(12_000);
      expect(processUpdate).toHaveBeenCalledTimes(12);
      expect(svc.chatPending.size).toBe(0);
    });
  });

  describe('#11: bitta ish throw qilsa navbat buzilmaydi', () => {
    it('birinchi ish yiqilsa ikkinchisi baribir bajariladi', async () => {
      const svc = make();
      const done: number[] = [];
      svc.enqueueChat('3', () => Promise.reject(new Error('bir ish yiqildi')));
      svc.enqueueChat('3', () => {
        done.push(2);
        return Promise.resolve();
      });
      await drain(svc);
      expect(done).toEqual([2]);
      expect(svc.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('bir ish yiqildi'),
      );
      expect(svc.chatPending.size).toBe(0);
    });

    it('sinxron throw ham zanjirni buzmaydi', async () => {
      const svc = make();
      const done: number[] = [];
      svc.enqueueChat('3', () => {
        throw new Error('sync throw');
      });
      svc.enqueueChat('3', () => {
        done.push(2);
        return Promise.resolve();
      });
      await drain(svc);
      expect(done).toEqual([2]);
    });
  });

  it('FIFO: bitta chat ishlari kelgan tartibda, parallel EMAS', async () => {
    const svc = make();
    const order: number[] = [];
    const task = (n: number, delay: number) => async () => {
      await sleep(delay);
      order.push(n);
    };
    // 1-ish UZOQ, 2/3 qisqa: parallel bo'lsa 2,3,1 bo'lardi.
    expect(svc.enqueueChat('1', task(1, 40))).toBe(true);
    expect(svc.enqueueChat('1', task(2, 5))).toBe(true);
    expect(svc.enqueueChat('1', task(3, 5))).toBe(true);
    await jest.advanceTimersByTimeAsync(100);
    expect(order).toEqual([1, 2, 3]);
  });

  it("pollLoop orqali FIFO: bitta chat update'lari kelgan tartibda", async () => {
    const svc = make();
    const order: number[] = [];
    svc.processUpdate = async (update: TestUpdate) => {
      await sleep(update.update_id === 1 ? 40 : 5);
      order.push(update.update_id);
    };
    mockGetUpdates([
      textUpdate(1, 9, 'a'),
      textUpdate(2, 9, 'b'),
      textUpdate(3, 9, 'c'),
    ]);
    await svc.pollLoop();
    await jest.advanceTimersByTimeAsync(100);
    expect(order).toEqual([1, 2, 3]);
  });

  describe('onModuleDestroy', () => {
    it("polling to'xtaydi va navbat yo'q bo'lsa darhol qaytadi", async () => {
      const svc = make();
      const tick = jest.fn();
      svc.timer = setTimeout(tick, 1_000);

      await svc.onModuleDestroy();

      expect(svc.running).toBe(false);
      expect(svc.timer).toBeNull();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(tick).not.toHaveBeenCalled();
    });

    it('navbatdagi ishlar tugashini kutadi', async () => {
      const svc = make();
      let finished = false;
      svc.enqueueChat('1', async () => {
        await sleep(3_000);
        finished = true;
      });
      let destroyed = false;
      const destroying = svc.onModuleDestroy().then(() => {
        destroyed = true;
      });

      await jest.advanceTimersByTimeAsync(2_999);
      expect(destroyed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await destroying;
      expect(finished).toBe(true);
      expect(destroyed).toBe(true);
      expect(svc.logger.warn).not.toHaveBeenCalled();
    });

    it("osilib qolgan ishni ko'pi bilan 8 s kutadi", async () => {
      const svc = make();
      svc.enqueueChat('1', () => new Promise<void>(() => undefined));
      let destroyed = false;
      const destroying = svc.onModuleDestroy().then(() => {
        destroyed = true;
      });

      await jest.advanceTimersByTimeAsync(7_999);
      expect(destroyed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await destroying;
      expect(destroyed).toBe(true);
      expect(svc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('still busy after 8000ms'),
      );
    });

    it("to'xtatilgandan keyin kelgan getUpdates natijasi navbatga qo'yilmaydi", async () => {
      const svc = make();
      const processUpdate = jest.fn(() => Promise.resolve());
      svc.processUpdate = processUpdate;
      svc.running = false;
      mockGetUpdates([textUpdate(5, 1, 'kech qoldi')]);

      await svc.pollLoop();

      // Offset oshmadi — Telegram bu update'ni keyingi ishga tushishda beradi.
      expect(svc.offset).toBe(0);
      expect(svc.chatQueues.size).toBe(0);
      expect(processUpdate).not.toHaveBeenCalled();
    });
  });

  it('getUpdates 409 — bitta replika haqida aniq ERROR', async () => {
    const svc = make();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409 });

    await svc.pollLoop();

    expect(svc.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('single replica'),
    );
    expect(svc.scheduleNext).toHaveBeenCalledWith(3000);
  });
});
