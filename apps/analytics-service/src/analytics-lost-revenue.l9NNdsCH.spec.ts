import {
  AnalyticsServiceService,
  DASHBOARD_TARGETS,
} from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock(
  '@app/common',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('@app/common'),
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  }),
);

/**
 * (l9NNdsCH) Dashboard: `orders.lostRevenue` («Yo'qotilgan daromad»),
 * `targets.successRate` (maqsad), revenue `chart.profitValues` («Sof foyda»).
 */
const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

beforeEach(() => {
  rmqSendMock
    .mockReset()
    .mockImplementation((_client: unknown, pattern: { cmd: string }) => {
      const responses: Record<string, unknown> = {
        'order.analytics.overview': {
          acceptedCount: 10,
          soldAndPaid: 6,
          cancelled: 3,
          lostRevenue: 450000,
          totalRevenue: 600000,
          profit: 90000,
        },
        'order.analytics.revenue': {
          data: [
            { period: '2026-10-23', revenue: 200000, profit: 30000 },
            { period: '2026-10-24', revenue: 100000, profit: -5000 },
          ],
          summary: { totalRevenue: 300000, totalProfit: 25000 },
        },
        'branch.user.find_by_user': { data: { branch_id: '16' } },
      };
      return Promise.resolve(responses[pattern.cmd] ?? []);
    });
});

describe('l9NNdsCH — dashboard lostRevenue va maqsad', () => {
  it('⭐ admin: orders.lostRevenue va targets.successRate', async () => {
    const res = (await make().getDashboard(
      { id: '1', roles: ['admin'] },
      {},
    )) as { data: Record<string, Record<string, unknown>> };
    expect(res.data.orders).toMatchObject({
      cancelled: 3,
      lostRevenue: 450000,
    });
    expect(res.data.targets).toEqual({ successRate: 80 });
    expect(DASHBOARD_TARGETS.successRate).toBe(80);
  });

  it('⭐ rol: registrator — lostRevenue ham yashiriladi (moliyaviy)', async () => {
    const res = (await make().getDashboard(
      { id: '5', roles: ['registrator'], branch_id: '16' },
      {},
    )) as { data: Record<string, Record<string, unknown>> };
    expect(res.data.orders).not.toHaveProperty('lostRevenue');
    expect(res.data.orders).not.toHaveProperty('profit');
    expect(res.data.orders).toMatchObject({ cancelled: 3 });
  });

  it('manager (filial) lostRevenue ni ko`radi', async () => {
    const res = (await make().getDashboard(
      { id: '6', roles: ['manager'], branch_id: '16' },
      {},
    )) as { data: { orders: Record<string, unknown> } };
    expect(res.data.orders.lostRevenue).toBe(450000);
  });
});

describe('l9NNdsCH — /analytics/revenue profit', () => {
  it('⭐ data[].profit, summary.totalProfit va chart.profitValues', async () => {
    const res = (await make().getRevenueStats(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-10-23', endDate: '2026-10-24' },
    )) as {
      data: {
        data: Array<{ profit: number }>;
        summary: Record<string, unknown>;
        chart: Record<string, unknown>;
      };
    };
    expect(res.data.data.map((b) => b.profit)).toEqual([30000, -5000]);
    expect(res.data.summary.totalProfit).toBe(25000);
    expect(res.data.chart.profitValues).toEqual([30000, -5000]);
  });
});
