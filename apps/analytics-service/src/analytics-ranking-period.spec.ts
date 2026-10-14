import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (PQt3n1N0) Reytinglar so'ralgan davrga bog'langan: KPI, buyurtmalar
 * hisoboti, kuryerlar hisoboti va dashboard `top_*` ga AYNI oraliqni
 * uzatadi; meta (`min_orders`, `filtered_out`, `from`, `to`) javobga chiqadi.
 */
const ADMIN = { id: '1', roles: ['superadmin'] };
const RANGE = {
  startDate: '2025-12-31T19:00:00.000Z',
  endDate: '2026-01-31T18:59:59.999Z',
};

function make() {
  return new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function payloadOf(cmd: string) {
  const call = rmqSendMock.mock.calls.find(
    ([, pattern]: [unknown, { cmd: string }]) => pattern.cmd === cmd,
  );
  expect(call).toBeDefined();
  return call![2] as Record<string, unknown>;
}

describe('analytics ranking period propagation (PQt3n1N0)', () => {
  beforeEach(() => {
    rmqSendMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ data: [] }));
  });

  it('⭐ TC2: KPI top_markets ga KPI oralig`ini uzatadi (oxirgi 30 kun EMAS)', async () => {
    await make().getKpiStats(ADMIN, {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(payloadOf('order.analytics.top_markets')).toMatchObject({
      limit: 10,
      ...RANGE,
      include_meta: true,
    });
  });

  it('buyurtmalar hisoboti top_markets ga hisobot oralig`ini uzatadi', async () => {
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd: string }) =>
      Promise.resolve(
        pattern.cmd === 'order.find_all'
          ? { data: [], total: 0 }
          : { data: [] },
      ),
    );
    await make().getOrderReport(ADMIN, {
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    expect(payloadOf('order.analytics.top_markets')).toMatchObject(RANGE);
  });

  it('⭐ TC1: kuryerlar hisoboti top_couriers ga davrni uzatadi va rankingMeta qaytaradi', async () => {
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd: string }) =>
      Promise.resolve(
        pattern.cmd === 'order.analytics.top_couriers'
          ? {
              items: [{ courier_id: '7', total_orders: 3 }],
              min_orders: 1,
              filtered_out: 0,
              from: RANGE.startDate,
              to: RANGE.endDate,
            }
          : [],
      ),
    );
    const res = (await make().getCourierReport(ADMIN, {
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    })) as { data: Record<string, unknown> };
    expect(payloadOf('order.analytics.top_couriers')).toMatchObject({
      limit: 20,
      ...RANGE,
      include_meta: true,
    });
    expect(res.data.ranking).toEqual([{ courier_id: '7', total_orders: 3 }]);
    expect(res.data.rankingMeta).toEqual({
      min_orders: 1,
      filtered_out: 0,
      from: RANGE.startDate,
      to: RANGE.endDate,
    });
  });

  it('⭐ TC4: dashboard (01.09–18.09) topMarkets/topBranches shu davrdan, meta bilan', async () => {
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd: string }) => {
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({ acceptedCount: 40 });
      }
      if (pattern.cmd === 'order.analytics.top_markets') {
        return Promise.resolve({
          items: [{ market_id: '4', total_orders: 12 }],
          min_orders: 1,
          filtered_out: 0,
          from: '2026-08-31T19:00:00.000Z',
          to: '2026-09-18T18:59:59.999Z',
        });
      }
      return Promise.resolve([]);
    });
    const res = (await make().getDashboard(ADMIN, {
      startDate: '2026-09-01',
      endDate: '2026-09-18',
    })) as { data: Record<string, unknown> };
    expect(payloadOf('order.analytics.top_markets')).toMatchObject({
      startDate: '2026-08-31T19:00:00.000Z',
      endDate: '2026-09-18T18:59:59.999Z',
      include_meta: true,
    });
    expect(payloadOf('order.analytics.top_branches')).toMatchObject({
      startDate: '2026-08-31T19:00:00.000Z',
      include_meta: true,
    });
    expect(res.data.topMarkets).toEqual([{ market_id: '4', total_orders: 12 }]);
    expect(res.data.topMarketsMeta).toEqual({
      min_orders: 1,
      filtered_out: 0,
      from: '2026-08-31T19:00:00.000Z',
      to: '2026-09-18T18:59:59.999Z',
    });
  });
});
