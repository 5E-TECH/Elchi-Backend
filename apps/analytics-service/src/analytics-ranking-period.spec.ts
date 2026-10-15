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
      // (9zbSDkUI) 2+ kunlik davr — reyting AYNAN tanlangan davr bo'yicha.
      period_rule: 'selected_range',
      period_days: null,
      selected_from: '2026-08-31T19:00:00.000Z',
      selected_to: '2026-09-18T18:59:59.999Z',
    });
  });
});

/**
 * (9zbSDkUI, 1-variant) Admin/filial dashboardida bitta Toshkent kuni
 * tanlanganda (standart "Bugun" ham) "Top marketlar"/"Top filiallar"
 * reytingi shu kun bilan tugaydigan OXIRGI 30 KUN bo'yicha olinadi —
 * kunlik ko'rinishda kartalar bo'sh qolmasin (BeePost naqshi). 2+ kunlik
 * davrda esa aynan tanlangan davr (PQt3n1N0 TC4 buzilmasin). Qolgan
 * bo'laklar (overview, market_stats, ...) tanlangan kunda qoladi.
 */
describe('9zbSDkUI — dashboard reyting oynasi ("Bugun" → oxirgi 30 kun)', () => {
  const NOW = new Date('2026-10-14T07:00:00.000Z');
  const TODAY_FROM = '2026-10-13T19:00:00.000Z';
  const TODAY_TO = '2026-10-14T18:59:59.999Z';
  const LAST30_FROM = '2026-09-14T19:00:00.000Z';

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    rmqSendMock
      .mockReset()
      .mockImplementation(
        (
          _c: unknown,
          pattern: { cmd: string },
          payload: Record<string, unknown>,
        ) => {
          if (pattern.cmd === 'order.analytics.overview') {
            return Promise.resolve({ acceptedCount: 1 });
          }
          if (pattern.cmd === 'order.analytics.market_stat') {
            return Promise.resolve({ totalOrders: 1 });
          }
          if (
            pattern.cmd === 'order.analytics.top_markets' ||
            pattern.cmd === 'order.analytics.top_branches'
          ) {
            return Promise.resolve({
              items: [{ id: '4', total_orders: 3 }],
              min_orders: 1,
              filtered_out: 0,
              from: payload.startDate,
              to: payload.endDate,
            });
          }
          return Promise.resolve([]);
        },
      );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function dashboard(
    filter: Record<string, unknown>,
    requester: { id: string; roles: string[]; branch_id?: string } = ADMIN,
  ) {
    return (await make().getDashboard(requester, filter)) as {
      data: Record<string, unknown>;
    };
  }

  it('⭐ TC1/TC3: sanasiz (standart "Bugun") — reyting oxirgi 30 kun, meta "last_30_days"', async () => {
    const res = await dashboard({});
    expect(payloadOf('order.analytics.overview')).toMatchObject({
      startDate: TODAY_FROM,
      endDate: TODAY_TO,
    });
    for (const cmd of [
      'order.analytics.top_markets',
      'order.analytics.top_branches',
    ]) {
      expect(payloadOf(cmd)).toMatchObject({
        startDate: LAST30_FROM,
        endDate: TODAY_TO,
        include_meta: true,
      });
    }
    const expectedMeta = {
      min_orders: 1,
      filtered_out: 0,
      from: LAST30_FROM,
      to: TODAY_TO,
      period_rule: 'last_30_days',
      period_days: 30,
      selected_from: TODAY_FROM,
      selected_to: TODAY_TO,
    };
    expect(res.data.topMarketsMeta).toEqual(expectedMeta);
    expect(res.data.topBranchesMeta).toEqual(expectedMeta);
    expect(res.data.topMarkets).toEqual([{ id: '4', total_orders: 3 }]);
  });

  it('⭐ TC1: startDate=endDate (bugun) — xuddi shu oxirgi 30 kun', async () => {
    await dashboard({ startDate: '2026-10-14', endDate: '2026-10-14' });
    expect(payloadOf('order.analytics.top_markets')).toMatchObject({
      startDate: LAST30_FROM,
      endDate: TODAY_TO,
    });
    expect(payloadOf('order.analytics.overview')).toMatchObject({
      startDate: TODAY_FROM,
    });
  });

  it('o`tgan bitta kun — o`sha kun bilan tugaydigan 30 kun (bugun emas)', async () => {
    await dashboard({ startDate: '2026-09-05', endDate: '2026-09-05' });
    expect(payloadOf('order.analytics.top_branches')).toMatchObject({
      startDate: '2026-08-06T19:00:00.000Z',
      endDate: '2026-09-05T18:59:59.999Z',
    });
  });

  it('PQt3n1N0 regressiya: 2 kunlik davr — aynan tanlangan davr, meta "selected_range"', async () => {
    const res = await dashboard({
      startDate: '2026-10-13',
      endDate: '2026-10-14',
    });
    expect(payloadOf('order.analytics.top_markets')).toMatchObject({
      startDate: '2026-10-12T19:00:00.000Z',
      endDate: TODAY_TO,
    });
    expect(res.data.topMarketsMeta).toMatchObject({
      from: '2026-10-12T19:00:00.000Z',
      period_rule: 'selected_range',
      period_days: null,
      selected_from: '2026-10-12T19:00:00.000Z',
      selected_to: TODAY_TO,
    });
  });

  it('filial roli — 30 kunlik reyting ham o`z filiali bilan cheklangan', async () => {
    await dashboard(
      { period: 'today' },
      { id: '9', roles: ['manager'], branch_id: '3' },
    );
    expect(payloadOf('order.analytics.top_branches')).toMatchObject({
      startDate: LAST30_FROM,
      endDate: TODAY_TO,
      branch_id: '3',
    });
    expect(payloadOf('order.analytics.overview')).toMatchObject({
      startDate: TODAY_FROM,
      branch_id: '3',
    });
  });

  it('market roli tarmog`i o`zgarmaydi — tanlangan kun, period_rule yo`q', async () => {
    const res = await dashboard({}, { id: '201', roles: ['market'] });
    expect(payloadOf('order.analytics.top_markets')).toMatchObject({
      startDate: TODAY_FROM,
      endDate: TODAY_TO,
    });
    expect(res.data.topMarketsMeta).not.toHaveProperty('period_rule');
  });
});
