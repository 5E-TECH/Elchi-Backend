import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (DwrMygfo) dashboard va KPI javobida `previous` (oldingi teng davr) va
 * `series` (14 kun) — ikkinchi og'ir dashboard so'rovisiz delta va sparkline.
 */
const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

const TREND = {
  previous: {
    from: '2026-10-10T19:00:00.000Z',
    to: '2026-10-17T18:59:59.999Z',
    acceptedCount: 8,
    soldAndPaid: 4,
    cancelled: 2,
    lostRevenue: 50000,
    totalRevenue: 400000,
    profit: 60000,
    deliveredCount: 4,
    deliveryMsTotal: 4 * 3600000,
    onTimeCount: 3,
  },
  series: [
    {
      date: '2026-10-23',
      acceptedCount: 0,
      soldAndPaid: 0,
      totalRevenue: 0,
      profit: 0,
      cancelled: 0,
      lostRevenue: 0,
      deliveredCount: 0,
      deliveryMsTotal: 0,
      onTimeCount: 0,
    },
    {
      date: '2026-10-24',
      acceptedCount: 5,
      soldAndPaid: 2,
      totalRevenue: '200000',
      profit: 30000,
      cancelled: 1,
      lostRevenue: 70000,
      deliveredCount: 2,
      deliveryMsTotal: 2 * 2 * 3600000,
      onTimeCount: 1,
    },
  ],
  series_days: 14,
};

type Call = [unknown, { cmd: string }, Record<string, unknown>];
const payloadOf = (cmd: string) =>
  (rmqSendMock.mock.calls as Call[]).find(([, p]) => p.cmd === cmd)?.[2];

function route(trend: unknown = TREND) {
  rmqSendMock
    .mockReset()
    .mockImplementation((_client: unknown, pattern: { cmd: string }) => {
      const responses: Record<string, unknown> = {
        'order.analytics.overview': {
          acceptedCount: 10,
          soldAndPaid: 6,
          cancelled: 3,
          totalRevenue: 600000,
          profit: 90000,
        },
        'order.analytics.fulfillment_stats': {
          deliveredCount: 6,
          deliveryMsTotal: 6 * 3600000,
          onTimeCount: 6,
        },
        'order.analytics.trend': trend,
        'branch.user.find_by_user': { data: { branch_id: '16' } },
      };
      const value = responses[pattern.cmd];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value === undefined ? [] : value);
    });
}

describe('DwrMygfo — dashboard previous va series', () => {
  it('⭐ admin: previous (overview qiymatlari) va 14 kunlik series, bitta qo`shimcha RPC', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '1', roles: ['admin'] },
      { startDate: '2026-10-18', endDate: '2026-10-24' },
    )) as { data: Record<string, any> };
    expect(payloadOf('order.analytics.trend')).toEqual({
      startDate: '2026-10-17T19:00:00.000Z',
      endDate: '2026-10-24T18:59:59.999Z',
    });
    expect(res.data.previous).toEqual({
      from: TREND.previous.from,
      to: TREND.previous.to,
      acceptedCount: 8,
      soldAndPaid: 4,
      cancelled: 2,
      totalRevenue: 400000,
      profit: 60000,
      lostRevenue: 50000,
    });
    expect(res.data.series).toHaveLength(2);
    expect(res.data.series[1]).toEqual({
      date: '2026-10-24',
      acceptedCount: 5,
      soldAndPaid: 2,
      cancelled: 1,
      totalRevenue: 200000,
      profit: 30000,
      lostRevenue: 70000,
    });
    expect(res.data.degraded).toBe(false);
  });

  it('filial roli (manager): trend o`z filiali bilan so`raladi', async () => {
    route();
    await make().getDashboard(
      { id: '6', roles: ['manager'], branch_id: '16' },
      {},
    );
    expect(payloadOf('order.analytics.trend')).toMatchObject({
      branch_id: '16',
    });
  });

  it('SA ?branch_id= — trend tanlangan filial bilan', async () => {
    route();
    await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { branch_id: '5' },
    );
    expect(payloadOf('order.analytics.trend')).toMatchObject({
      branch_id: '5',
    });
  });

  it('⭐ rol: registrator — previous/series da moliyaviy maydonlar YO`Q', async () => {
    route();
    const res = (await make().getDashboard(
      { id: '5', roles: ['registrator'], branch_id: '16' },
      {},
    )) as { data: Record<string, any> };
    expect(res.data.previous).toEqual({
      from: TREND.previous.from,
      to: TREND.previous.to,
      acceptedCount: 8,
      soldAndPaid: 4,
      cancelled: 2,
    });
    expect(res.data.series[1]).not.toHaveProperty('totalRevenue');
    expect(res.data.series[1]).not.toHaveProperty('profit');
  });

  it('«Barchasi»: all bayrog`i trend ga uzatiladi, previous null bo`lsa null', async () => {
    route({ ...TREND, previous: null });
    const res = (await make().getDashboard(
      { id: '1', roles: ['admin'] },
      { all: true },
    )) as { data: Record<string, any> };
    expect(payloadOf('order.analytics.trend')).toMatchObject({ all: true });
    expect(res.data.previous).toBeNull();
    expect(res.data.series).toHaveLength(2);
  });

  it('trend tushsa — 200, previous/series null, failed_parts: [trend]', async () => {
    route(new Error('timeout'));
    const res = (await make().getDashboard(
      { id: '1', roles: ['admin'] },
      {},
    )) as { data: Record<string, any> };
    expect(res.data).toMatchObject({
      previous: null,
      series: null,
      degraded: true,
      failed_parts: ['trend'],
    });
  });
});

describe('DwrMygfo — KPI previous va series', () => {
  it('⭐ previous KPI (AYNI formulalar) va kunlik KPI seriyasi', async () => {
    route();
    const res = (await make().getKpiStats(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-10-18', endDate: '2026-10-24' },
    )) as { data: Record<string, any> };
    expect(res.data.previous).toEqual({
      from: TREND.previous.from,
      to: TREND.previous.to,
      averageOrderValue: 100000,
      averageFulfillmentHours: 1,
      onTimeRate: 75,
      deliveryCount: 4,
      cancellationRate: 25,
    });
    expect(res.data.series[0]).toEqual({
      date: '2026-10-23',
      averageOrderValue: 0,
      averageFulfillmentHours: 0,
      onTimeRate: 0,
      deliveryCount: 0,
      cancellationRate: 0,
    });
    expect(res.data.series[1]).toEqual({
      date: '2026-10-24',
      averageOrderValue: 100000,
      averageFulfillmentHours: 2,
      onTimeRate: 50,
      deliveryCount: 2,
      cancellationRate: 20,
    });
    // Joriy qiymatlar o'zgarmagan.
    expect(res.data).toMatchObject({ onTimeRate: 100, deliveryCount: 6 });
  });

  it('KPI trend tushsa — previous/series null, degraded', async () => {
    route(new Error('timeout'));
    const res = (await make().getKpiStats(
      { id: '1', roles: ['admin'] },
      {},
    )) as { data: Record<string, any> };
    expect(res.data).toMatchObject({
      previous: null,
      series: null,
      degraded: true,
      failed_parts: ['trend'],
    });
  });
});
