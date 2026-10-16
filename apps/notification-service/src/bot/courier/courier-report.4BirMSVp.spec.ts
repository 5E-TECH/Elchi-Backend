import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_TYPES } from '@app/common';
import { COMMAND_NOT_LINKED_TEXT, COMMAND_ROLE_DENIED_TEXT } from '../handlers/command-gate.handler';
import {
  courierActor,
  fakeOrdersGateway,
  makeRouter,
  marketActor,
  sentTexts,
  textUpdate,
} from '../testing/bot-kit-spec';
import { CourierReportScheduler, deterministicUuid } from './courier-report.scheduler';
import { buildCourierDailyReport } from './courier.handler';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * 4BirMSVp — kuryer kunlik hisoboti (`/kun` + avtomatik) va VICfJuoi #2
 * (`/balans` — market FOR_MARKET kassasi), `/kassa` (kuryer kassasi).
 * Manbalar tayyor (analytics myStat, my-cashbox) — kuryer/market o'z JWT'si
 * bilan; xabar bot o'zi emas, `notification.dispatch` (in-app + Telegram).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

const stats = {
  totalOrders: '12',
  soldOrders: 9,
  canceledOrders: '3',
  profit: '45000.00',
  successRate: '75.0',
};

describe('4BirMSVp — /kun', () => {
  it('⭐ /kun — 5 ta son + kassa qoldig‘i bitta xabarda, notification.dispatch (in-app + Telegram) orqali', async () => {
    const gateway = fakeOrdersGateway([], { stats, cashbox: { balance: '1250000.00' } });
    const ctx = makeRouter({ actor: courierActor('25'), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/kun', { chatId: 25 }));
    expect(gateway.calls.map((call) => call.path)).toEqual([
      '/analytics/dashboard?period=today',
      '/finance/cashbox/my-cashbox',
    ]);
    // Bot o'zi sendMessage QILMAYDI.
    expect(sentTexts(ctx)).toEqual([]);
    expect(ctx.inbox.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'courier.daily_report',
        recipient_id: '25',
        channels: ['in_app', 'telegram'],
        body: [
          'Jami: 12, sotildi: 9, bekor: 3',
          'Muvaffaqiyat: 75%',
          "Daromad: 45 000 so'm",
          "💰 Kassada: 1 250 000 so'm",
        ].join('\n'),
      }),
    );
  });

  it('⭐ pul maydonlari son sifatida formatlanadi (numeric satr konkatenatsiyasi yo‘q)', async () => {
    const gateway = fakeOrdersGateway([], {
      stats: { ...stats, profit: '1000', totalOrders: '1' },
      cashbox: { balance: '500' },
    });
    const report = await buildCourierDailyReport(gateway as never, '25');
    expect(report).toContain("Daromad: 1 000 so'm");
    expect(report).not.toContain('1000500');
  });

  it('bog‘lanmagan chat — /kun ma’lumot bermaydi', async () => {
    const gateway = fakeOrdersGateway([], { stats });
    const ctx = makeRouter({ actor: null, gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/kun', { chatId: 25 }));
    expect(sentTexts(ctx)).toEqual([COMMAND_NOT_LINKED_TEXT]);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it('kun chegarasi server tomonda Asia/Tashkent (period=today) — bot o‘zi sana hisoblamaydi', async () => {
    const gateway = fakeOrdersGateway([], { stats });
    await buildCourierDailyReport(gateway as never, '25');
    expect(gateway.calls[0].path).toBe('/analytics/dashboard?period=today');
  });

  it('katalog: courier.daily_report — Telegram sukut kanallarda', () => {
    const type = NOTIFICATION_TYPES.find((entry) => entry.key === 'courier.daily_report');
    expect(type?.default_channels).toEqual(['in_app', 'telegram']);
  });
});

describe('4BirMSVp — avtomatik hisobot (scheduler)', () => {
  const makeScheduler = (couriers: Array<{ user_id: string; telegram_id: string }>) => {
    const dispatch = jest.fn().mockResolvedValue({});
    const gateway = fakeOrdersGateway([], { stats, cashbox: { balance: '0' } });
    rmqSendMock.mockResolvedValue({ data: couriers });
    const scheduler = new CourierReportScheduler(
      { get: () => '' } as never,
      { addCronJob: jest.fn() } as never,
      gateway as never,
      { get: () => ({ dispatch }) } as never,
      {} as never,
    );
    return { scheduler, dispatch, gateway };
  };

  it('⭐ 100 ulangan kuryer — har biriga bitta dispatch, kunlik idempotent id', async () => {
    const couriers = Array.from({ length: 100 }, (_, i) => ({
      user_id: String(1000 + i),
      telegram_id: String(5_550_000 + i),
    }));
    const { scheduler, dispatch } = makeScheduler(couriers);
    const now = new Date('2026-10-16T18:30:00Z'); // 23:30 Toshkent
    const result = await scheduler.run(now);
    expect(result).toEqual({ couriers: 100, dispatched: 100, failed: 0 });
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'identity.telegram.linked_users' },
      { role: 'courier' },
      expect.anything(),
    );
    const first = dispatch.mock.calls[0][0] as { client_request_id: string; recipient_id: string };
    expect(first.recipient_id).toBe('1000');
    expect(first.client_request_id).toBe(deterministicUuid('courier-daily:1000:2026-10-16'));
    expect(first.client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Qayta ishga tushsa — ayni id (inbox takrorni rad etadi).
    await scheduler.run(now);
    expect(dispatch.mock.calls[100][0].client_request_id).toBe(first.client_request_id);
  });

  it('⭐ bog‘lanmagan kuryerga urinilmaydi (faqat linked_users ro‘yxati)', async () => {
    const { scheduler, dispatch } = makeScheduler([]);
    expect(await scheduler.run()).toEqual({ couriers: 0, dispatched: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('bitta kuryer xatosi qolganlarini to‘xtatmaydi', async () => {
    const { scheduler, dispatch } = makeScheduler([
      { user_id: '1', telegram_id: '11' },
      { user_id: '2', telegram_id: '22' },
    ]);
    dispatch.mockRejectedValueOnce(new Error('boom'));
    expect(await scheduler.run()).toEqual({ couriers: 2, dispatched: 1, failed: 1 });
  });

  it('⭐ 429 olinmaydi: Telegram yuborish outbox token-bucket orqali (bot o‘z sendMessage yo‘lini ochmaydi)', () => {
    const src = readFileSync(join(__dirname, 'courier-report.scheduler.ts'), 'utf8');
    expect(src).not.toMatch(/sendMessage|sendDirectToGroup|BotOutboxService/);
    expect(src).toMatch(/inbox\.dispatch\(/);
  });
});

describe('VICfJuoi #2 / /kassa — o‘z kassasi, o‘z JWT bilan', () => {
  it('⭐ /balans bog‘langan market — o‘z FOR_MARKET kassasi qoldig‘i', async () => {
    const gateway = fakeOrdersGateway([], {
      cashbox: { balance: '2500000.00', balance_cash: '1000000', balance_card: '1500000' },
    });
    const ctx = makeRouter({ actor: marketActor('37'), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/balans', { chatId: 37 }));
    expect(gateway.calls.map((call) => call.path)).toEqual(['/finance/cashbox/my-cashbox']);
    expect(sentTexts(ctx).at(-1)).toBe(
      [
        '💰 Balans (market kassasi):',
        "Jami: 2 500 000 so'm",
        "Naqd: 1 000 000 so'm",
        "Karta: 1 500 000 so'm",
      ].join('\n'),
    );
  });

  it('⭐ /balans bog‘lanmagan chat — "avval ulang", son ko‘rsatilmaydi', async () => {
    const gateway = fakeOrdersGateway([], { cashbox: { balance: '1' } });
    const ctx = makeRouter({ actor: null, gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/balans', { chatId: 37 }));
    expect(sentTexts(ctx)).toEqual([COMMAND_NOT_LINKED_TEXT]);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it('⭐ Market A chatidan Market B kassasi so‘ralib bo‘lmaydi — so‘rovda parametr yo‘q, doira JWT’dan', async () => {
    const gateway = fakeOrdersGateway([], { cashbox: { balance: '1' } });
    const ctx = makeRouter({ actor: marketActor('37'), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/balans 38', { chatId: 37 }));
    expect(gateway.request).not.toHaveBeenCalled();
    await ctx.router.dispatch('elchi', textUpdate('/balans', { chatId: 37, updateId: 2 }));
    expect(gateway.calls[0].path).toBe('/finance/cashbox/my-cashbox');
    expect(gateway.request.mock.calls[0][0]).toBe('37');
  });

  it('kuryer /kassa — o‘z kassasi; kuryer /balans — rad', async () => {
    const gateway = fakeOrdersGateway([], { cashbox: { balance: '300000' } });
    const ctx = makeRouter({ actor: courierActor(), gateway: gateway.request });
    await ctx.router.dispatch('elchi', textUpdate('/kassa', { chatId: 25 }));
    expect(sentTexts(ctx).at(-1)).toContain("Jami: 300 000 so'm");
    await ctx.router.dispatch('elchi', textUpdate('/balans', { chatId: 25, updateId: 2 }));
    expect(sentTexts(ctx).at(-1)).toBe(COMMAND_ROLE_DENIED_TEXT);
  });
});
