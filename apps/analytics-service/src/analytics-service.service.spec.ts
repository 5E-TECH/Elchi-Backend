import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  Order_status: {
    NEW: 'new',
    RECEIVED: 'received',
    ON_THE_ROAD: 'on_the_road',
    SOLD: 'sold',
    PAID: 'paid',
    PARTLY_PAID: 'partly_paid',
    CANCELLED: 'cancelled',
    CANCELLED_SENT: 'cancelled_sent',
    CLOSED: 'closed',
  },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    COURIER: 'courier',
    MARKET: 'market',
    MARKET_OPERATOR: 'market_operator',
    BRANCH: 'branch',
    MANAGER: 'manager',
    OPERATOR: 'operator',
    REGISTRATOR: 'registrator',
  },
  rmqSend: (...args: any[]) => rmqSendMock(...args),
}));

describe('AnalyticsServiceService', () => {
  let service: AnalyticsServiceService;

  beforeEach(() => {
    rmqSendMock.mockReset();
    service = new AnalyticsServiceService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('getDashboard returns courier-specific payload for courier role', async () => {
    rmqSendMock.mockResolvedValueOnce({
      data: {
        totalOrders: 7,
        soldOrders: 0,
        canceledOrders: 2,
        successRate: 0,
      },
    });

    const res = await service.getDashboard(
      { id: 'u1', roles: ['courier'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.myStat).toEqual({
      totalOrders: 7,
      soldOrders: 0,
      canceledOrders: 2,
      successRate: 0,
    });
    expect(res.data.couriers).toEqual([
      {
        courier: { id: 'u1' },
        totalOrders: 7,
        soldOrders: 0,
        canceledOrders: 2,
        successRate: 0,
      },
    ]);
    expect(res.data.topCouriers).toEqual([]);
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]) => pattern?.cmd === 'order.analytics.courier_stats',
      ),
    ).toBe(false);
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]) => pattern?.cmd === 'order.analytics.top_couriers',
      ),
    ).toBe(false);
  });

  it('getDashboard returns market-specific payload for market role', async () => {
    rmqSendMock
      .mockResolvedValueOnce({ data: { sold: 2 } })
      .mockResolvedValueOnce({ data: [{ id: 'm1' }] })
      .mockResolvedValueOnce({ data: [{ id: 'tm1' }] })
      .mockResolvedValueOnce({ data: [{ id: 'op1' }] });

    const res = await service.getDashboard(
      { id: 'm1', roles: ['market'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.myStat).toEqual({ sold: 2 });
    expect(res.data.topOperators).toEqual([{ id: 'op1' }]);
  });

  it('getDashboard general branch returns pcs-compatible payload', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      const cmd = pattern?.cmd;
      if (cmd === 'order.analytics.overview')
        return Promise.resolve({ data: { acceptedCount: 1 } });
      if (cmd === 'order.analytics.market_stats')
        return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.courier_stats')
        return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.top_markets')
        return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.top_couriers')
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });

    const res = await service.getDashboard(
      { id: 'admin', roles: ['superadmin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.orders).toEqual({ acceptedCount: 1 });
    expect(res.data).not.toHaveProperty('activeCouriers');
    expect(res.data).not.toHaveProperty('newUsersCount');
  });

  it('getDashboard uses the lightweight all-time path', async () => {
    rmqSendMock.mockResolvedValue({
      data: { acceptedCount: 100, soldAndPaid: 70, totalRevenue: 5000 },
    });

    const res = await service.getDashboard(
      { id: 'admin', roles: ['superadmin'] },
      { all: true },
    );

    expect(res.data.orders).toEqual({
      acceptedCount: 100,
      soldAndPaid: 70,
      totalRevenue: 5000,
    });
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]) => pattern?.cmd === 'order.analytics.overview',
      ),
    ).toBe(true);
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]) => pattern?.cmd === 'order.analytics.market_stats',
      ),
    ).toBe(false);
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]) => pattern?.cmd === 'order.analytics.courier_stats',
      ),
    ).toBe(false);
  });

  it('removes all financial totals from registrator all-time dashboard', async () => {
    rmqSendMock.mockResolvedValue({
      data: {
        acceptedCount: 100,
        soldAndPaid: 70,
        profit: 1200,
        totalRevenue: 5000,
        total_revenue: 5000,
      },
    });

    const res = await service.getDashboard(
      { id: 'registrator-1', roles: ['registrator'], branch_id: '16' },
      { all: true },
    );

    expect(res.data.orders).toEqual({
      acceptedCount: 100,
      soldAndPaid: 70,
    });
  });

  it.each([
    ['today', '2026-06-10T19:00:00.000Z'],
    ['week', '2026-06-07T19:00:00.000Z'],
    ['month', '2026-05-31T19:00:00.000Z'],
  ])(
    'getDashboard resolves %s in Tashkent time',
    async (period, expectedStart) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-11T10:00:00.000Z'));
      rmqSendMock.mockResolvedValue({ data: [] });

      await service.getDashboard(
        { id: 'admin', roles: ['superadmin'] },
        { period },
      );

      const overviewCall = rmqSendMock.mock.calls.find(
        ([, pattern]) => pattern?.cmd === 'order.analytics.overview',
      );
      expect(overviewCall?.[2]).toEqual({
        startDate: expectedStart,
        endDate: '2026-06-11T18:59:59.999Z',
      });
    },
  );

  it('uses requester branch_id for manager branch dashboard', async () => {
    const scopedCommands = new Set([
      'order.analytics.overview',
      'order.analytics.market_stats',
      'order.analytics.courier_stats',
      'order.analytics.top_markets',
      'order.analytics.top_couriers',
    ]);
    rmqSendMock.mockImplementation(
      (_client: any, pattern: any, payload: any) => {
        if (scopedCommands.has(pattern?.cmd)) {
          expect(payload.branch_id).toBe('16');
        }
        if (pattern?.cmd === 'branch.dashboard') {
          expect(payload.id).toBe('16');
          return Promise.resolve({ data: { branchId: '16' } });
        }
        if (pattern?.cmd === 'branch.user.find_by_user') {
          throw new Error('branch assignment lookup should not be needed');
        }
        return Promise.resolve({ data: [] });
      },
    );

    const res = await service.getDashboard(
      { id: '2', roles: ['manager'], branch_id: '16' },
      { period: 'today' },
    );

    expect(res.data.branchDashboard).toEqual({ branchId: '16' });
  });

  it('getRevenueStats defaults invalid period to daily', async () => {
    rmqSendMock.mockImplementation(
      (_client: any, pattern: any, payload: any) => {
        if (pattern.cmd === 'order.analytics.revenue') {
          expect(payload.period).toBe('daily');
          return Promise.resolve({
            data: {
              data: [{ label: 'D1', revenue: 100 }],
              summary: { totalRevenue: 100 },
            },
          });
        }
        return Promise.resolve({ data: { balance: 1 } });
      },
    );

    const res = await service.getRevenueStats({ id: 'a', roles: ['admin'] }, {
      period: 'bad',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.chart.labels).toEqual(['D1']);
  });

  it('getRevenueStats builds empty chart when revenue data is empty', async () => {
    rmqSendMock
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { any: 1 } })
      .mockResolvedValueOnce({ data: { items: [] } });

    const res = await service.getRevenueStats(
      { id: 'a', roles: ['admin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.chart.labels).toEqual([]);
    expect(res.data.chart.values).toEqual([]);
  });

  it('getKpiStats calculates KPI metrics', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({
          data: { acceptedCount: 10, soldAndPaid: 5, cancelled: 2 },
        });
      }
      if (pattern.cmd === 'order.analytics.revenue') {
        return Promise.resolve({
          data: { summary: { totalRevenue: 1000 }, data: [] },
        });
      }
      if (pattern.cmd === 'order.analytics.courier_stats') {
        return Promise.resolve({
          data: [{ totalOrders: 4 }, { totalOrders: 6 }],
        });
      }
      if (pattern.cmd === 'order.analytics.top_markets') {
        return Promise.resolve({ data: [{ id: 'm1' }] });
      }
      if (pattern.cmd === 'order.find_all') {
        return Promise.resolve({ data: [], total: 0, page: 1, limit: 200 });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getKpiStats(
      { id: 'a', roles: ['admin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.averageOrderValue).toBe(200);
    expect(res.data.cancellationRate).toBe(20);
    expect(res.data.courierEfficiency).toBe(5);
  });

  it('getKpiStats groups long all-time ranges yearly', async () => {
    rmqSendMock.mockResolvedValue({ data: [] });

    await service.getKpiStats({ id: 'a', roles: ['admin'] }, {
      startDate: '1970-01-01',
      endDate: '2026-06-20',
    } as any);

    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.analytics.revenue' },
      expect.objectContaining({ period: 'yearly' }),
    );
  });

  it('getOrderReport returns status distribution object', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.overview')
        return Promise.resolve({ data: { acceptedCount: 1 } });
      if (pattern.cmd === 'order.analytics.top_markets')
        return Promise.resolve({ data: [] });
      if (pattern.cmd === 'order.find_all')
        return Promise.resolve({ data: [], total: 0, page: 1, limit: 200 });
      return Promise.resolve({ data: {} });
    });

    const res = await service.getOrderReport(
      { id: 'a', roles: ['admin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.statusDistribution).toHaveProperty('new');
    expect(res.data.statusDistribution).toHaveProperty('sold');
  });

  it('getFinanceReport calculates net from histories', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'finance.cashbox.all_info') {
        return Promise.resolve({
          data: {
            allCashboxHistories: [
              {
                operation_type: 'income',
                amount: 300,
                createdAt: new Date().toISOString(),
              },
              {
                operation_type: 'expense',
                amount: 100,
                createdAt: new Date().toISOString(),
              },
            ],
          },
        });
      }
      if (pattern.cmd === 'finance.cashbox.financial_balance') {
        return Promise.resolve({
          data: {
            markets: { marketsTotalBalans: 11 },
            couriers: { couriersTotalBalanse: 7 },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getFinanceReport(
      { id: 'a', roles: ['admin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.totalIncome).toBe(300);
    expect(res.data.totalOutcome).toBe(100);
    expect(res.data.net).toBe(200);
  });

  // Audit 2026-06-07: financial reports must reject non-admin roles (P0 leak fix).
  it.each([
    ['getFinanceReport'],
    ['getRevenueStats'],
    ['getKpiStats'],
    ['getOrderReport'],
  ])('%s forbids a non-admin requester (403)', async (method) => {
    const courier = { id: 'c1', roles: ['courier'] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any)
      [method](courier, {})
      .then(() => {
        throw new Error('expected 403');
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((e: any) => {
        expect(e?.getError?.()?.statusCode).toBe(403);
      });
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('financial reports allow an admin requester (no 403)', async () => {
    rmqSendMock.mockResolvedValue({ data: {} });
    const admin = { id: 'a', roles: ['admin'] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await service.getFinanceReport(admin as any, {} as any);
    expect(res.statusCode).toBe(200);
  });

  it('getCourierReport filters only requester courier data', async () => {
    rmqSendMock.mockImplementation(
      (_client: any, pattern: any, payload: any) => {
        if (pattern.cmd === 'order.analytics.courier_stats') {
          return Promise.resolve({
            data: [
              {
                courier: { id: 'c1' },
                soldOrders: 2,
                totalOrders: 3,
                successRate: 66,
              },
            ],
          });
        }
        if (pattern.cmd === 'order.analytics.top_couriers') {
          return Promise.resolve({ data: [] });
        }
        if (pattern.cmd === 'order.analytics.courier_stat') {
          return Promise.resolve({ data: { profit: 500, canceledOrders: 1 } });
        }
        return Promise.resolve({ data: {} });
      },
    );

    const res = await service.getCourierReport(
      { id: 'c1', roles: ['courier'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].courier.id).toBe('c1');
  });

  it('getCourierReport returns all items for non-courier requester', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.courier_stats') {
        return Promise.resolve({
          data: [
            {
              courier: { id: 'c1' },
              soldOrders: 2,
              totalOrders: 3,
              successRate: 66,
            },
          ],
        });
      }
      if (pattern.cmd === 'order.analytics.top_couriers') {
        return Promise.resolve({ data: [] });
      }
      if (pattern.cmd === 'order.analytics.courier_stat') {
        return Promise.resolve({ data: { profit: 500, canceledOrders: 1 } });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getCourierReport(
      { id: 'admin', roles: ['superadmin'] },
      {} as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.items.length).toBeGreaterThan(0);
  });
});
