import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (6CYRjoZG) GET /analytics/dashboard?branch_id= — SA/ADMIN uchun filial
 * kesimi: KPI (overview), «Kunlik daromad», holat donut, «Kuryerlar
 * reytingi» va branch.dashboard. Boshqa rollarda `branch_id` e'tiborsiz.
 */
const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

type Call = [unknown, { cmd: string }, Record<string, unknown>];
const calls = () => rmqSendMock.mock.calls as Call[];
const payloadOf = (cmd: string) =>
  calls().find(([, pattern]) => pattern.cmd === cmd)?.[2];
const cmds = () => calls().map(([, pattern]) => pattern.cmd);

function route(overrides: Record<string, unknown> = {}) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }) => {
      const responses: Record<string, unknown> = {
        'order.analytics.overview': {
          acceptedCount: 10,
          soldAndPaid: 6,
          cancelled: 2,
          totalRevenue: 600000,
          profit: 120000,
        },
        'order.analytics.market_stats': [],
        'order.analytics.courier_stats': [],
        'order.analytics.top_markets': {
          items: [],
          min_orders: 1,
          filtered_out: 0,
        },
        'order.analytics.top_branches': {
          items: [],
          min_orders: 1,
          filtered_out: 0,
        },
        'order.analytics.revenue': {
          data: [
            {
              period: '2026-10-23',
              label: '23.10',
              ordersCount: 2,
              revenue: 200000,
            },
            {
              period: '2026-10-24',
              label: '24.10',
              ordersCount: 4,
              revenue: 400000,
            },
          ],
          summary: { totalRevenue: 600000, totalOrders: 6, avgRevenue: 300000 },
        },
        'order.analytics.status_distribution': {
          distribution: { sold: 6, cancelled: 2, new: 2 },
          total: 10,
        },
        'order.analytics.top_couriers': {
          items: [
            {
              courier_id: '7',
              courier_name: 'Ali',
              total_orders: 5,
              successful_orders: 4,
              success_rate: 80,
            },
          ],
          min_orders: 1,
          filtered_out: 0,
          from: null,
          to: null,
        },
        'branch.dashboard': { data: { couriers_count: 3 } },
        'branch.user.find_by_user': { data: { branch_id: '16' } },
        ...overrides,
      };
      const value = responses[pattern.cmd];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value ?? []);
    },
  );
}

describe('6CYRjoZG — dashboard branch_id (SA/ADMIN)', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it('⭐ superadmin + branch_id: barcha bo`laklar filial kesimida, qo`shimcha maydonlar bor', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-10-18', endDate: '2026-10-24', branch_id: '5' },
    )) as { data: Record<string, any> };

    for (const cmd of [
      'order.analytics.overview',
      'order.analytics.market_stats',
      'order.analytics.courier_stats',
      'order.analytics.top_markets',
      'order.analytics.revenue',
      'order.analytics.status_distribution',
      'order.analytics.top_couriers',
    ]) {
      expect(payloadOf(cmd)).toMatchObject({ branch_id: '5' });
    }
    expect(payloadOf('order.analytics.revenue')).toMatchObject({
      period: 'daily',
    });
    expect(payloadOf('branch.dashboard')).toMatchObject({ id: '5' });

    expect(res.data).toMatchObject({
      branch_id: '5',
      orders: { acceptedCount: 10, soldAndPaid: 6, profit: 120000 },
      dailyRevenue: {
        data: [
          expect.objectContaining({ period: '2026-10-23', revenue: 200000 }),
          expect.objectContaining({ period: '2026-10-24', revenue: 400000 }),
        ],
        summary: { totalRevenue: 600000 },
      },
      statusDistribution: {
        distribution: { sold: 6, cancelled: 2, new: 2 },
        total: 10,
      },
      topCouriers: [
        expect.objectContaining({ courier_id: '7', success_rate: 80 }),
      ],
      branchDashboard: { couriers_count: 3 },
      degraded: false,
    });
    expect(res.data.topCouriersMeta).toMatchObject({ min_orders: 1 });
  });

  it('admin ham branch_id bilan filial kesimini oladi', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '2', roles: ['admin'] },
      { branch_id: '9' },
    )) as { data: Record<string, any> };
    expect(payloadOf('order.analytics.overview')).toMatchObject({
      branch_id: '9',
    });
    expect(res.data.branch_id).toBe('9');
  });

  it('branch_id yo`q — kompaniya dashboardi o`zgarmagan (qo`shimcha bo`laklar so`ralmaydi)', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      {},
    )) as { data: Record<string, any> };
    expect(payloadOf('order.analytics.overview')).not.toHaveProperty(
      'branch_id',
    );
    expect(cmds()).not.toContain('order.analytics.status_distribution');
    expect(cmds()).not.toContain('order.analytics.top_couriers');
    expect(cmds()).not.toContain('branch.dashboard');
    expect(res.data).not.toHaveProperty('dailyRevenue');
    expect(res.data).not.toHaveProperty('branch_id');
  });

  it('⭐ rol: manager boshqa filial branch_id sini yuborsa — O`Z filiali (16), boshqa filial emas', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '3', roles: ['manager'] },
      { branch_id: '5' },
    )) as { data: Record<string, any> };
    expect(payloadOf('order.analytics.overview')).toMatchObject({
      branch_id: '16',
    });
    expect(cmds()).not.toContain('order.analytics.status_distribution');
    expect(res.data).not.toHaveProperty('dailyRevenue');
  });

  it('rol: market branch_id yuborsa — market dashboardi (filial kesimi yo`q)', async () => {
    route({ 'order.analytics.market_stat': { totalOrders: 1 } });
    const res = (await make().getDashboard(
      { id: '4', roles: ['market'] },
      { branch_id: '5' },
    )) as { data: Record<string, any> };
    expect(cmds()).not.toContain('order.analytics.overview');
    expect(res.data).not.toHaveProperty('branch_id');
  });

  it('qo`shimcha bo`lak tushsa — 200, null + failed_parts (degraded)', async () => {
    route({
      'order.analytics.status_distribution': new Error('timeout'),
      'order.analytics.revenue': new Error('timeout'),
    });
    const res = (await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { branch_id: '5' },
    )) as { data: Record<string, any> };
    expect(res.data).toMatchObject({
      statusDistribution: null,
      dailyRevenue: null,
      degraded: true,
      failed_parts: ['dailyRevenue', 'statusDistribution'],
    });
  });
});
