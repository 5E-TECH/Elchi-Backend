import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (XdKajqLe) «Barchasi» davri: /analytics/kpi va /analytics/revenue
 * `all=true` bilan — barcha order bo'laklari `all: true`, javobda
 * dashboard (uN1tjjGu) bilan bir xil `clamped`/`effective_*` meta.
 */
const CLAMPED = {
  requested_from: null,
  requested_to: null,
  applied_from: '2025-10-23T19:00:00.000Z',
  applied_to: '2026-10-24T08:00:00.000Z',
  clamped: true,
  max_span_days: 366,
};

const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

type Call = [unknown, { cmd: string }, Record<string, unknown>];
const payloadOf = (cmd: string) =>
  (rmqSendMock.mock.calls as Call[]).find(([, p]) => p.cmd === cmd)?.[2];

beforeEach(() => {
  rmqSendMock
    .mockReset()
    .mockImplementation((_client: unknown, pattern: { cmd: string }) => {
      const responses: Record<string, unknown> = {
        'order.analytics.overview': {
          acceptedCount: 300,
          soldAndPaid: 200,
          cancelled: 50,
          totalRevenue: 20000000,
          applied_range: CLAMPED,
        },
        'order.analytics.revenue': {
          data: [{ period: 'M:2026-10', revenue: 20000000, ordersCount: 200 }],
          summary: { totalRevenue: 20000000 },
          applied_range: CLAMPED,
        },
        'order.analytics.courier_stats': [
          { courier: { id: '7' }, totalOrders: 100 },
        ],
        'order.analytics.top_markets': {
          items: [],
          min_orders: 1,
          filtered_out: 0,
        },
        'order.analytics.fulfillment_stats': {
          deliveredCount: 200,
          deliveryMsTotal: 200 * 3600000,
          onTimeCount: 150,
          applied_range: CLAMPED,
        },
        'finance.cashbox.financial_balance': { main: { balance: 0 } },
        'branch.find_all': { items: [] },
      };
      return Promise.resolve(responses[pattern.cmd] ?? null);
    });
});

describe('XdKajqLe — KPI all=true', () => {
  it('⭐ barcha order bo`laklari all: true bilan, javobda clamped meta', async () => {
    const res = (await make().getKpiStats(
      { id: '1', roles: ['superadmin'] },
      { all: true },
    )) as { data: Record<string, unknown>; message: string };
    for (const cmd of [
      'order.analytics.overview',
      'order.analytics.revenue',
      'order.analytics.courier_stats',
      'order.analytics.top_markets',
      'order.analytics.fulfillment_stats',
    ]) {
      expect(payloadOf(cmd)).toMatchObject({ all: true });
    }
    expect(payloadOf('order.analytics.revenue')).toMatchObject({
      period: 'monthly',
    });
    expect(res.data).toMatchObject({
      onTimeRate: 75,
      deliveryCount: 200,
      averageOrderValue: 100000,
      courierEfficiency: 100,
      clamped: true,
      effective_from: CLAMPED.applied_from,
      effective_to: CLAMPED.applied_to,
      max_span_days: 366,
    });
    expect(res.message).toBe('KPI stats (oxirgi 366 kun)');
  });

  it('all yo`q — `all` kaliti uzatilmaydi, meta yo`q (eski xulq)', async () => {
    const res = (await make().getKpiStats(
      { id: '1', roles: ['admin'] },
      { startDate: '2026-10-01', endDate: '2026-10-24' },
    )) as { data: Record<string, unknown> };
    expect(payloadOf('order.analytics.overview')).not.toHaveProperty('all');
    expect(res.data).not.toHaveProperty('clamped');
  });

  it('rol: market — 403', async () => {
    await expect(
      make().getKpiStats({ id: '9', roles: ['market'] }, { all: true }),
    ).rejects.toBeDefined();
  });
});

describe('XdKajqLe — revenue all=true', () => {
  it('⭐ order.analytics.revenue all: true, javobda clamped meta', async () => {
    const res = (await make().getRevenueStats(
      { id: '1', roles: ['admin'] },
      { all: true, period: 'monthly' },
    )) as { data: Record<string, unknown> };
    expect(payloadOf('order.analytics.revenue')).toMatchObject({
      all: true,
      period: 'monthly',
    });
    expect(res.data).toMatchObject({
      clamped: true,
      effective_from: CLAMPED.applied_from,
      summary: { totalRevenue: 20000000 },
    });
  });

  it('all yo`q — meta yo`q', async () => {
    const res = (await make().getRevenueStats(
      { id: '1', roles: ['admin'] },
      {},
    )) as { data: Record<string, unknown> };
    expect(payloadOf('order.analytics.revenue')).not.toHaveProperty('all');
    expect(res.data).not.toHaveProperty('clamped');
  });
});
