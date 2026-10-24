import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (5tUEVG1B) Kuryer dashboardida boshqa kuryerlar orasidagi o'rni ko'rinadi.
 * Ilgari `topCouriers: []` qo'lda yozilgan edi. Endi
 * `order.analytics.top_couriers` (tanlangan davr, PQt3n1N0) dan — faqat ism,
 * buyurtmalar soni, sotilgan soni va ulush; PUL maydonlari yo'q.
 */
const ranked = Array.from({ length: 12 }, (_, i) => ({
  courier_id: String(100 + i),
  courier_name: `Kuryer ${i + 1}`,
  total_orders: 50 - i,
  successful_orders: 40 - i,
  success_rate: 90 - i,
  // order-service kelajakda qo'shsa ham kuryerga chiqmasligi kerak:
  profit: 1_000_000,
  salary: 3_000_000,
  courier_tariff: 25_000,
  phone_number: '+998901234567',
}));

function route(myStat: unknown = { totalOrders: 9, soldOrders: 7 }) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }) => {
      if (pattern.cmd === 'order.analytics.courier_stat') {
        return Promise.resolve({ data: myStat });
      }
      if (pattern.cmd === 'order.analytics.top_couriers') {
        return Promise.resolve({
          data: {
            items: ranked,
            min_orders: 1,
            filtered_out: 0,
            from: '2026-10-13T19:00:00.000Z',
            to: '2026-10-14T18:59:59.999Z',
          },
        });
      }
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({ acceptedCount: 1 });
      }
      return Promise.resolve({ data: [] });
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

describe('5tUEVG1B — kuryer dashboardida reyting', () => {
  beforeEach(() => {
    rmqSendMock.mockReset();
    // "Bugun" = 14.10.2026 (Toshkent).
    jest.useFakeTimers({ now: new Date('2026-10-14T07:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('⭐ TC1/TC5: kuryer tokeni bilan topCouriers BO`SH EMAS (top-10)', async () => {
    route();
    const res = await make().getDashboard(
      { id: '102', roles: ['courier'] },
      {},
    );
    const data = res.data as Record<string, any>;
    expect(data.topCouriers).toHaveLength(10);
    expect(data.topCouriers[0]).toEqual({
      courier_id: '100',
      courier_name: 'Kuryer 1',
      total_orders: 50,
      successful_orders: 40,
      success_rate: 90,
    });
    expect(data.topCouriersMeta).toEqual({
      min_orders: 1,
      filtered_out: 0,
      from: '2026-10-13T19:00:00.000Z',
      to: '2026-10-14T18:59:59.999Z',
    });
    const call = rmqSendMock.mock.calls.find(
      ([, pattern]: [unknown, { cmd: string }]) =>
        pattern.cmd === 'order.analytics.top_couriers',
    );
    // Tanlangan davr (bugun, Toshkent) va meta bilan so'raladi.
    expect(call?.[2]).toMatchObject({
      startDate: '2026-10-13T19:00:00.000Z',
      include_meta: true,
    });
  });

  it('⭐ TC2: boshqa kuryerlarning pul maydonlari (profit, salary, tarif, telefon) YO`Q', async () => {
    route();
    const res = await make().getDashboard(
      { id: '102', roles: ['courier'] },
      {},
    );
    const data = res.data as Record<string, any>;
    const serialized = JSON.stringify([data.topCouriers, data.myRanking]);
    for (const key of [
      'profit',
      'salary',
      'courier_tariff',
      'phone_number',
      'totalAmount',
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    for (const row of data.topCouriers) {
      expect(Object.keys(row).sort()).toEqual([
        'courier_id',
        'courier_name',
        'success_rate',
        'successful_orders',
        'total_orders',
      ]);
    }
  });

  it('⭐ TC3: so`rovchining o`z id`si va o`rni bor — top-10 ichida', async () => {
    route();
    const res = await make().getDashboard(
      { id: '102', roles: ['courier'] },
      {},
    );
    const data = res.data as Record<string, any>;
    expect(data.couriers[0].courier.id).toBe('102');
    expect(data.myRank).toBe(3);
    expect(data.myRanking).toMatchObject({ courier_id: '102' });
  });

  it('TC3: top-10 dan tashqaridagi kuryer ham o`rnini biladi; reytingda yo`q bo`lsa null', async () => {
    route();
    const outside = await make().getDashboard(
      { id: '111', roles: ['courier'] },
      {},
    );
    expect(outside.data.myRank).toBe(12);
    expect(outside.data.topCouriers).toHaveLength(10);

    const absent = await make().getDashboard(
      { id: '999', roles: ['courier'] },
      {},
    );
    expect(absent.data.myRank).toBeNull();
    expect(absent.data.myRanking).toBeNull();
  });

  it('⭐ TC4: admin/superadmin javob shakli o`zgarmagan (topCouriers yo`q, top_couriers so`ralmaydi)', async () => {
    route();
    const res = await make().getDashboard({ id: '1', roles: ['admin'] }, {});
    const data = res.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'orders',
        'markets',
        'couriers',
        'topMarkets',
        'topMarketsMeta',
        'topBranches',
        'topBranchesMeta',
        'branchDashboard',
        // (l9NNdsCH) qo'shimcha: maqsad qiymatlari.
        'targets',
        // (DwrMygfo) qo'shimcha: oldingi davr va 14 kunlik seriya.
        'previous',
        'series',
        'degraded',
        'failed_parts',
      ].sort(),
    );
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]: [unknown, { cmd: string }]) =>
          pattern.cmd === 'order.analytics.top_couriers',
      ),
    ).toBe(false);
  });
});
