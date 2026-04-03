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
    COURIER: 'courier',
    MARKET: 'market',
  },
  rmqSend: (...args: any[]) => rmqSendMock(...args),
}));

describe('AnalyticsServiceService', () => {
  let service: AnalyticsServiceService;

  beforeEach(() => {
    rmqSendMock.mockReset();
    service = new AnalyticsServiceService({} as any, {} as any, {} as any);
  });

  it('getDashboard returns courier-specific payload for courier role', async () => {
    rmqSendMock
      .mockResolvedValueOnce({ data: { sold: 1 } })
      .mockResolvedValueOnce({ data: [{ id: 'c1' }] })
      .mockResolvedValueOnce({ data: [{ id: 'top1' }] });

    const res = await service.getDashboard({ id: 'u1', roles: ['courier'] }, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.myStat).toEqual({ sold: 1 });
  });

  it('getDashboard returns market-specific payload for market role', async () => {
    rmqSendMock
      .mockResolvedValueOnce({ data: { sold: 2 } })
      .mockResolvedValueOnce({ data: [{ id: 'm1' }] })
      .mockResolvedValueOnce({ data: [{ id: 'tm1' }] });

    const res = await service.getDashboard({ id: 'm1', roles: ['market'] }, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.myStat).toEqual({ sold: 2 });
  });

  it('getDashboard general branch computes activeCouriers and newUsersCount', async () => {
    const now = new Date().toISOString();

    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      const cmd = pattern?.cmd;
      if (cmd === 'order.analytics.overview') return Promise.resolve({ data: { acceptedCount: 1 } });
      if (cmd === 'order.analytics.market_stats') return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.courier_stats') return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.top_markets') return Promise.resolve({ data: [] });
      if (cmd === 'order.analytics.top_couriers') return Promise.resolve({ data: [] });
      if (cmd === 'finance.cashbox.financial_balance') return Promise.resolve({ data: { ok: true } });
      if (cmd === 'identity.courier.find_all') return Promise.resolve({ data: { items: [], meta: { total: 5, totalPages: 1 } } });
      if (cmd === 'identity.user.find_all') return Promise.resolve({ data: { items: [{ createdAt: now }], meta: { total: 1, totalPages: 1 } } });
      if (cmd === 'identity.market.find_all') return Promise.resolve({ data: { items: [{ createdAt: now }], meta: { total: 1, totalPages: 1 } } });
      return Promise.resolve({ data: {} });
    });

    const res = await service.getDashboard({ id: 'admin', roles: ['superadmin'] }, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.activeCouriers).toBe(5);
    expect(res.data.newUsersCount).toBe(2);
  });

  it('getRevenueStats defaults invalid period to daily', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any, payload: any) => {
      if (pattern.cmd === 'order.analytics.revenue') {
        expect(payload.period).toBe('daily');
        return Promise.resolve({ data: { data: [{ label: 'D1', revenue: 100 }], summary: { totalRevenue: 100 } } });
      }
      return Promise.resolve({ data: { balance: 1 } });
    });

    const res = await service.getRevenueStats(undefined, { period: 'bad' } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.chart.labels).toEqual(['D1']);
  });

  it('getRevenueStats builds empty chart when revenue data is empty', async () => {
    rmqSendMock
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { any: 1 } });

    const res = await service.getRevenueStats(undefined, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.chart.labels).toEqual([]);
    expect(res.data.chart.values).toEqual([]);
  });

  it('getKpiStats calculates KPI metrics', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({ data: { acceptedCount: 10, soldAndPaid: 5, cancelled: 2 } });
      }
      if (pattern.cmd === 'order.analytics.revenue') {
        return Promise.resolve({ data: { summary: { totalRevenue: 1000 }, data: [] } });
      }
      if (pattern.cmd === 'order.analytics.courier_stats') {
        return Promise.resolve({ data: [{ totalOrders: 4 }, { totalOrders: 6 }] });
      }
      if (pattern.cmd === 'order.analytics.top_markets') {
        return Promise.resolve({ data: [{ id: 'm1' }] });
      }
      if (pattern.cmd === 'order.find_all') {
        return Promise.resolve({ data: [], total: 0, page: 1, limit: 200 });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getKpiStats(undefined, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.averageOrderValue).toBe(200);
    expect(res.data.cancellationRate).toBe(20);
    expect(res.data.courierEfficiency).toBe(5);
  });

  it('getOrderReport returns status distribution object', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.overview') return Promise.resolve({ data: { acceptedCount: 1 } });
      if (pattern.cmd === 'order.analytics.top_markets') return Promise.resolve({ data: [] });
      if (pattern.cmd === 'order.find_all') return Promise.resolve({ data: [], total: 0, page: 1, limit: 200 });
      return Promise.resolve({ data: {} });
    });

    const res = await service.getOrderReport(undefined, {} as any);

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
              { operation_type: 'income', amount: 300, createdAt: new Date().toISOString() },
              { operation_type: 'expense', amount: 100, createdAt: new Date().toISOString() },
            ],
          },
        });
      }
      if (pattern.cmd === 'finance.cashbox.financial_balance') {
        return Promise.resolve({ data: { markets: { marketsTotalBalans: 11 }, couriers: { couriersTotalBalanse: 7 } } });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getFinanceReport(undefined, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.totalIncome).toBe(300);
    expect(res.data.totalOutcome).toBe(100);
    expect(res.data.net).toBe(200);
  });

  it('getCourierReport filters only requester courier data', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any, payload: any) => {
      if (pattern.cmd === 'order.analytics.courier_stats') {
        return Promise.resolve({ data: [{ courier: { id: 'c1' }, soldOrders: 2, totalOrders: 3, successRate: 66 }] });
      }
      if (pattern.cmd === 'order.analytics.top_couriers') {
        return Promise.resolve({ data: [] });
      }
      if (pattern.cmd === 'order.analytics.courier_stat') {
        return Promise.resolve({ data: { profit: 500, canceledOrders: 1 } });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getCourierReport({ id: 'c1', roles: ['courier'] }, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].courier.id).toBe('c1');
  });

  it('getCourierReport returns all items for non-courier requester', async () => {
    rmqSendMock.mockImplementation((_client: any, pattern: any) => {
      if (pattern.cmd === 'order.analytics.courier_stats') {
        return Promise.resolve({ data: [{ courier: { id: 'c1' }, soldOrders: 2, totalOrders: 3, successRate: 66 }] });
      }
      if (pattern.cmd === 'order.analytics.top_couriers') {
        return Promise.resolve({ data: [] });
      }
      if (pattern.cmd === 'order.analytics.courier_stat') {
        return Promise.resolve({ data: { profit: 500, canceledOrders: 1 } });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await service.getCourierReport({ id: 'admin', roles: ['superadmin'] }, {} as any);

    expect(res.statusCode).toBe(200);
    expect(res.data.items.length).toBeGreaterThan(0);
  });
});
