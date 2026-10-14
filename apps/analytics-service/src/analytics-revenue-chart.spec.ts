import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (2Fj7iw1k) `/analytics/revenue` javobi: `chart.labels/values` to'ldirilgan,
 * raqamli "0","1" kalitlar yo'q, `data` massiv va davr yakuni `summary`.
 * Backend tuzatishi faAfgvW1/tVAWnl9O da (`unwrapRevenue`); bu spec karta
 * TC'larini order-service'ning AYNAN qaytaradigan xom shakli bilan
 * tekshiradi (oylik, 5 band, jonli summalar).
 */
const RAW_MONTHLY = {
  data: [
    { period: 'M:2026-05', label: '05.2026', ordersCount: 0, revenue: 0 },
    {
      period: 'M:2026-06',
      label: '06.2026',
      ordersCount: 18,
      revenue: 67300000,
    },
    {
      period: 'M:2026-07',
      label: '07.2026',
      ordersCount: 10,
      revenue: 41540000,
    },
    {
      period: 'M:2026-08',
      label: '08.2026',
      ordersCount: 9,
      revenue: 40000000,
    },
    {
      period: 'M:2026-09',
      label: '09.2026',
      ordersCount: 4,
      revenue: 18000000,
    },
  ],
  summary: { totalRevenue: 166840000, totalOrders: 41, avgRevenue: 33368000 },
};

describe('2Fj7iw1k — revenue chart va summary', () => {
  beforeEach(() => {
    rmqSendMock
      .mockReset()
      .mockImplementation((_c: unknown, pattern: { cmd: string }) =>
        Promise.resolve(
          pattern.cmd === 'order.analytics.revenue'
            ? RAW_MONTHLY
            : { data: null },
        ),
      );
  });

  const getRevenue = () =>
    new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ).getRevenueStats(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-05-31', endDate: '2026-09-18', period: 'monthly' },
    ) as Promise<{ data: Record<string, any> }>;

  it('⭐ TC1: chart.labels va chart.values uzunligi 5 (bandlar bilan bir xil tartibda)', async () => {
    const res = await getRevenue();
    expect(res.data.chart.labels).toEqual([
      '05.2026',
      '06.2026',
      '07.2026',
      '08.2026',
      '09.2026',
    ]);
    expect(res.data.chart.values).toEqual([
      0, 67300000, 41540000, 40000000, 18000000,
    ]);
  });

  it('⭐ TC2: raqamli "0","1",… kalitlar YO`Q, o`rniga data massivi', async () => {
    const res = await getRevenue();
    expect(Object.keys(res.data).filter((key) => /^\d+$/.test(key))).toEqual(
      [],
    );
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data).toHaveLength(5);
    expect(res.data.data[1]).toMatchObject({ ordersCount: 18 });
  });

  it('⭐ TC3: summary.totalRevenue = 166 840 000, summary.totalOrders = 41', async () => {
    const res = await getRevenue();
    expect(res.data.summary).toEqual(RAW_MONTHLY.summary);
    const chartSum = (res.data.chart.values as number[]).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(chartSum).toBe(res.data.summary.totalRevenue);
  });
});
