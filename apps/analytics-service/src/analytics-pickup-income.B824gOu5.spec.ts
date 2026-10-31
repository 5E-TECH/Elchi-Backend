import { Roles, rmqSend } from '@app/common';
import { AnalyticsServiceService } from './analytics-service.service';

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: jest.fn(),
}));

/**
 * B824gOu5 — foyda hisobotida pickup daromadi KO'RINADI. Order analitikasi
 * foydani faqat buyurtma tariflaridan hisoblaydi (`PROFIT_SQL`), pickup esa
 * buyurtmaga tegishli emas: qo'shilmasa jim yo'qolardi.
 */
describe('pickup daromadi hisobotda (B824gOu5)', () => {
  const rmqSendMock = rmqSend as jest.Mock;
  let service: AnalyticsServiceService;
  const pickup = {
    income: 40000,
    visits: 3,
    paid_visits: 2,
    free_visits: 1,
    parcels: 21,
  };

  beforeEach(() => {
    rmqSendMock.mockReset();
    rmqSendMock.mockImplementation((_client: unknown, pattern: any) => {
      if (pattern.cmd === 'finance.pickup_visit.income_summary') {
        return Promise.resolve({ statusCode: 200, data: pickup });
      }
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({ data: { profit: 100000, totalRevenue: 5 } });
      }
      return Promise.resolve({ data: {} });
    });
    service = new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const income = () =>
    rmqSendMock.mock.calls.filter(
      ([, pattern]) => pattern.cmd === 'finance.pickup_visit.income_summary',
    );

  it('moliya hisoboti: `pickup` bloki', async () => {
    const res = await service.getFinanceReport(
      { id: '1', roles: [Roles.ADMIN] },
      { fromDate: '2026-10-01', toDate: '2026-10-31' },
    );
    expect(res.data.pickup).toEqual(pickup);
    expect(income()[0][2]).toMatchObject({
      from_date: expect.any(String),
      to_date: expect.any(String),
    });
  });

  it('dashboard: `profit` o`zgarmaydi, pickup alohida va jami bilan', async () => {
    const res = await service.getDashboard(
      { id: '1', roles: [Roles.SUPERADMIN] },
      { startDate: '2026-10-01', endDate: '2026-10-31' },
    );
    expect(res.data.orders).toMatchObject({
      profit: 100000,
      pickupIncome: 40000,
      profitWithPickup: 140000,
      pickup,
    });
  });

  it('finance javob bermasa: 0 emas, maydon yo`q + degraded', async () => {
    const base = rmqSendMock.getMockImplementation() as (
      ...args: unknown[]
    ) => unknown;
    rmqSendMock.mockImplementation((client: unknown, pattern: any, ...rest) =>
      pattern.cmd === 'finance.pickup_visit.income_summary'
        ? Promise.reject(new Error('down'))
        : base(client, pattern, ...rest),
    );
    const res = await service.getDashboard(
      { id: '1', roles: [Roles.ADMIN] },
      { startDate: '2026-10-01', endDate: '2026-10-31' },
    );
    expect(res.data.orders).not.toHaveProperty('pickup');
    expect(res.data.orders).not.toHaveProperty('pickupIncome');
    expect(res.data.failed_parts).toContain('pickup');
  });

  it('filial kesimi va filial rollari — pickup so`ralmaydi', async () => {
    await service.getDashboard(
      { id: '1', roles: [Roles.ADMIN] },
      { startDate: '2026-10-01', endDate: '2026-10-31', branch_id: '5' },
    );
    expect(income()).toHaveLength(0);
  });
});
