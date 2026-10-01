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
