import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (mKS1mjNr) `/analytics/kpi` sotilgan buyurtmalarni RMQ orqali sahifalab
 * TORTMAYDI: o'rtacha yetkazish vaqti va SLA ulushi order-service'dagi
 * bitta SQL agregatidan (`order.analytics.fulfillment_stats`).
 */
const ADMIN = { id: '1', roles: ['admin'] };

function route(fulfillment: unknown) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }) => {
      switch (pattern.cmd) {
        case 'order.analytics.overview':
          return Promise.resolve({
            acceptedCount: 82,
            soldAndPaid: 41,
            cancelled: 10,
            totalRevenue: 166840000,
          });
        case 'order.analytics.fulfillment_stats':
          return fulfillment instanceof Error
            ? Promise.reject(fulfillment)
            : Promise.resolve(fulfillment);
        case 'order.find_all':
          throw new Error('KPI order.find_all ni chaqirmasligi kerak');
        default:
          return Promise.resolve({ data: [] });
      }
    },
  );
}

const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

describe('mKS1mjNr — KPI yetkazish vaqti SQL agregatidan', () => {
  beforeEach(() => {
    rmqSendMock.mockReset();
  });

  it('⭐ TC2: order-service ga ≤ 5 ta RMQ chaqiruv, order.find_all sahifalash YO`Q', async () => {
    route({
      deliveredCount: 41,
      deliveryMsTotal: 41 * 250.86 * 3600000,
      onTimeCount: 22,
    });
    await make().getKpiStats(ADMIN, {
      startDate: '2026-06-21',
      endDate: '2026-09-18',
    });
    const cmds = rmqSendMock.mock.calls.map(
      ([, pattern]: [unknown, { cmd: string }]) => pattern.cmd,
    );
    expect(cmds.length).toBeLessThanOrEqual(5);
    expect(cmds).not.toContain('order.find_all');
    expect(cmds).toContain('order.analytics.fulfillment_stats');
    const call = rmqSendMock.mock.calls.find(
      ([, pattern]: [unknown, { cmd: string }]) =>
        pattern.cmd === 'order.analytics.fulfillment_stats',
    );
    // TC7: oyna Toshkent kuni chegaralari bilan uzatiladi.
    expect(call?.[2]).toEqual({
      startDate: '2026-06-20T19:00:00.000Z',
      endDate: '2026-09-18T18:59:59.999Z',
    });
  });

  it('⭐ TC3/TC4: averageFulfillmentHours va onTimeRate eski formula bilan (250.86 / 53.66)', async () => {
    route({
      deliveredCount: 41,
      deliveryMsTotal: Math.round(41 * 250.86 * 3600000),
      onTimeCount: 22,
    });
    const res = (await make().getKpiStats(ADMIN, {
      startDate: '2026-06-21',
      endDate: '2026-09-18',
    })) as { data: Record<string, unknown> };
    expect(res.data.averageFulfillmentHours).toBe(250.86);
    expect(res.data.onTimeRate).toBe(53.66);
    expect(res.data.degraded).toBe(false);
  });

  it('⭐ TC6: SQL numeric SATR qaytarsa ham raqamga aylanadi', async () => {
    route({
      data: {
        deliveredCount: '4',
        deliveryMsTotal: '43200000',
        onTimeCount: '3',
      },
    });
    const res = (await make().getKpiStats(ADMIN, {})) as {
      data: Record<string, unknown>;
    };
    expect(res.data.averageFulfillmentHours).toBe(3);
    expect(res.data.onTimeRate).toBe(75);
  });

  it('agregat yo`q (buyurtma yo`q) — 0, yiqilmaydi', async () => {
    route({ deliveredCount: 0, deliveryMsTotal: 0, onTimeCount: 0 });
    const res = (await make().getKpiStats(ADMIN, {})) as {
      data: Record<string, unknown>;
    };
    expect(res.data.averageFulfillmentHours).toBe(0);
    expect(res.data.onTimeRate).toBe(0);
  });

  it('(VkwhHqvW) fulfillment bo`lagi tushsa — 200, failed_parts: [fulfillment]', async () => {
    route(new Error('timeout'));
    const res = (await make().getKpiStats(ADMIN, {})) as {
      data: Record<string, unknown>;
    };
    expect(res.data).toMatchObject({
      degraded: true,
      failed_parts: ['fulfillment'],
      averageOrderValue: 4069268.29,
    });
  });
});
