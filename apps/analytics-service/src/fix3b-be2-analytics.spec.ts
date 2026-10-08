import { AnalyticsServiceService } from './analytics-service.service';

/**
 * fix3b BE-2 (item 5) — getFinanceReport oylik kaliti Toshkent oyi:
 * +5 soat siljitilgandan KEYIN getUTCFullYear/getUTCMonth. Kod fix3 (A7)
 * da allaqachon to'g'rilangan; bu spec oy oxiri va YIL chegarasini qotiradi.
 */

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
  Order_status: { SOLD: 'sold', CANCELLED: 'cancelled' },
  Roles: { SUPERADMIN: 'superadmin', ADMIN: 'admin' },
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

const routeHistories = (
  rows: Array<{ operation_type: string; amount: number; createdAt: string }>,
) =>
  rmqSendMock.mockImplementation((_client: unknown, pattern: { cmd: string }) =>
    Promise.resolve(
      pattern.cmd === 'finance.cashbox.all_info'
        ? { data: { allCashboxHistories: rows } }
        : { data: {} },
    ),
  );

describe('fix3b — moliya hisobotining oylik kaliti (Toshkent, +5 soat)', () => {
  let service: AnalyticsServiceService;

  beforeEach(() => {
    rmqSendMock.mockReset();
    service = new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('yil chegarasi: 31-dekabr 19:00Z (Toshkentda 1-yanvar 00:00) keyingi yilning yanvariga tushadi', async () => {
    routeHistories([
      {
        operation_type: 'income',
        amount: 700,
        createdAt: '2026-12-31T19:00:00.000Z',
      },
      {
        operation_type: 'income',
        amount: 300,
        createdAt: '2026-12-31T18:59:59.999Z',
      },
    ]);

    const res = await service.getFinanceReport(
      { id: '1', roles: ['superadmin'] },
      {} as never,
    );

    expect(res.data.monthlyDynamics).toEqual([
      { month: '2026-12', amount: 300 },
      { month: '2027-01', amount: 700 },
    ]);
  });

  it("oy o'rtasidagi yozuvlar o'zgarmaydi; xarajat manfiy hisoblanadi", async () => {
    routeHistories([
      {
        operation_type: 'income',
        amount: 1000,
        createdAt: '2026-10-15T09:00:00.000Z',
      },
      {
        operation_type: 'expense',
        amount: 250,
        createdAt: '2026-10-31T18:00:00.000Z',
      },
      {
        operation_type: 'expense',
        amount: 100,
        createdAt: '2026-10-31T19:30:00.000Z',
      },
    ]);

    const res = await service.getFinanceReport(
      { id: '1', roles: ['admin'] },
      {} as never,
    );

    expect(res.data.monthlyDynamics).toEqual([
      { month: '2026-10', amount: 750 },
      { month: '2026-11', amount: -100 },
    ]);
  });
});

describe('QGxC7v1E — jami kirim/chiqim limitga bog`liq emas', () => {
  let service: AnalyticsServiceService;
  const allInfo = {
    data: {
      // Sahifada faqat 2 qator — eski hisob net = -4000 berardi.
      allCashboxHistories: [
        {
          operation_type: 'income',
          amount: 1000,
          createdAt: '2026-09-01T10:00:00Z',
        },
        {
          operation_type: 'expense',
          amount: 5000,
          createdAt: '2026-09-02T10:00:00Z',
        },
      ],
      periodTotals: { income: 688661000, outcome: 412577000, net: 276084000 },
      periodMonthly: [
        { month: '2026-06', amount: 100 },
        { month: '2026-07', amount: 200 },
        { month: '2026-08', amount: 300 },
        { month: '2026-09', amount: 400 },
      ],
    },
  };

  beforeEach(() => {
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd: string }) =>
      Promise.resolve(
        pattern.cmd === 'finance.cashbox.all_info' ? allInfo : { data: {} },
      ),
    );
    service = new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it.each([undefined, 20, 1000])(
    '⭐ limit=%p — totalIncome/totalOutcome/net bir xil va musbat',
    async (limit) => {
      const res = await service.getFinanceReport(
        { id: '1', roles: ['superadmin'] },
        { fromDate: '2025-01-01', toDate: '2026-09-18', limit } as never,
      );
      expect(res.data.totalIncome).toBe(688661000);
      expect(res.data.totalOutcome).toBe(412577000);
      expect(res.data.net).toBe(276084000);
    },
  );

  it('⭐ monthlyDynamics oraliqdagi hamma oylarni beradi (sahifadan emas)', async () => {
    const res = await service.getFinanceReport(
      { id: '1', roles: ['superadmin'] },
      {} as never,
    );
    expect(
      res.data.monthlyDynamics.map((m: { month: string }) => m.month),
    ).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
  });

  it('⭐ limit=1000000 → finance-service ga 100 bilan, withTotals bilan ketadi', async () => {
    await service.getFinanceReport({ id: '1', roles: ['superadmin'] }, {
      limit: 1000000,
    } as never);
    const call = rmqSendMock.mock.calls.find(
      (c: unknown[]) =>
        (c[1] as { cmd: string }).cmd === 'finance.cashbox.all_info',
    );
    expect(call?.[2]).toMatchObject({ limit: 100, withTotals: true });
  });
});
