import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * 2026-11-04 (ega: «filialda faqat shu filialning foydalanuvchilari
 * ko'rinishi kerak»):
 *  - kuryer dashboardi «Top kuryerlar» — faqat kuryerning O'Z filiali
 *    kuryerlari (`branch_users` COURIER), `myRank` filial ichida; filialsiz
 *    kuryer — reyting bo'sh, `myRank: null`;
 *  - menejer / registrator dashboardi `couriers` jadvali — faqat filial
 *    kuryerlari (order-service filialga tegib o'tgan pochtalarning HAR
 *    kuryerini qaytaradi);
 *  - filialga biriktirilmagan filial roli — kompaniya bo'yicha dashboard
 *    EMAS, neytral javob (order-service'ga so'rov yo'q).
 */
type Pattern = { cmd: string };
type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

/** Kompaniya reytingi: 6 kuryer, 3 filial. Filial 16 — 101, 103, 105. */
const companyRanking = [
  { courier_id: '201', name: 'Begona A', rate: 99 },
  { courier_id: '101', name: 'Ali', rate: 95 },
  { courier_id: '202', name: 'Begona B', rate: 90 },
  { courier_id: '103', name: 'Vali', rate: 85 },
  { courier_id: '301', name: 'Begona C', rate: 80 },
  { courier_id: '105', name: 'Soli', rate: 70 },
].map((row) => ({
  courier_id: row.courier_id,
  courier_name: row.name,
  total_orders: 20,
  successful_orders: Math.round((row.rate * 20) / 100),
  success_rate: row.rate,
}));

const BRANCH_16_MEMBERS = [
  { user_id: '101', role: 'COURIER' },
  { user_id: '103', role: 'courier' },
  { user_id: '105', role: 'COURIER' },
  // Kuryer bo'lmagan a'zolar reytingga/jadvalga kirmaydi.
  { user_id: '25', role: 'MANAGER' },
  { user_id: '201', role: 'REGISTRATOR' },
];

const courierStatsRow = (id: string, name: string) => ({
  courier: { id, name, phone_number: '+998900000000', salary: 1 },
  totalOrders: 10,
  soldOrders: 5,
  successRate: 50,
});

function route(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    'order.analytics.courier_stat': () =>
      Promise.resolve({ data: { totalOrders: 9, soldOrders: 7 } }),
    'order.analytics.top_couriers': () =>
      Promise.resolve({
        data: {
          items: companyRanking,
          min_orders: 1,
          filtered_out: 0,
          from: '2026-10-13T19:00:00.000Z',
          to: '2026-10-14T18:59:59.999Z',
        },
      }),
    'order.analytics.overview': () =>
      Promise.resolve({ acceptedCount: 4, profit: 100, totalRevenue: 500 }),
    'order.analytics.courier_stats': () =>
      Promise.resolve({
        data: [
          courierStatsRow('101', 'Ali'),
          courierStatsRow('202', 'Begona B'),
          courierStatsRow('103', 'Vali'),
        ],
      }),
    'branch.user.find_by_user': () =>
      Promise.resolve({ data: { branch_id: '16' } }),
    'branch.user.find_by_branch': () =>
      Promise.resolve({ data: BRANCH_16_MEMBERS }),
    'branch.dashboard': () => Promise.resolve({ data: { branchId: '16' } }),
    ...overrides,
  };
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: Pattern, payload: Record<string, unknown>) =>
      (handlers[pattern.cmd] ?? (() => Promise.resolve({ data: [] })))(payload),
  );
}

const calls = (cmd: string) =>
  rmqSendMock.mock.calls.filter(([, pattern]: [unknown, Pattern]) => {
    return pattern.cmd === cmd;
  }) as Array<[unknown, Pattern, Record<string, unknown>]>;

const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

type Data = Record<string, any>;

const courierIds = (data: Data): string[] =>
  (data.topCouriers as Array<{ courier_id: string }>).map(
    (row) => row.courier_id,
  );

describe('2026-11-04 — kuryer reytingi va kuryer jadvali filial doirasida', () => {
  beforeEach(() => {
    rmqSendMock.mockReset();
    jest.useFakeTimers({ now: new Date('2026-10-14T07:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('kuryer dashboardi «Top kuryerlar»', () => {
    it('⭐ faqat o`z filiali kuryerlari; tartib saqlanadi; myRank filial ichida', async () => {
      route();
      const res = await make().getDashboard(
        { id: '103', roles: ['courier'] },
        {},
      );
      const data = res.data as Data;

      expect(courierIds(data)).toEqual(['101', '103', '105']);
      // Kompaniyada 4-o'rin, filialda — 2-o'rin.
      expect(data.myRank).toBe(2);
      expect(data.myRanking).toMatchObject({
        courier_id: '103',
        success_rate: 85,
      });
      expect(data.degraded).toBe(false);
      expect(data.failed_parts).toEqual([]);
      // Javob shakli o'zgarmagan.
      expect(data.topCouriersMeta).toEqual({
        min_orders: 1,
        filtered_out: 0,
        from: '2026-10-13T19:00:00.000Z',
        to: '2026-10-14T18:59:59.999Z',
      });
    });

    it('filial a`zolari kuryerning o`z filiali va o`z requester`i bilan so`raladi', async () => {
      route();
      const requester = { id: '103', roles: ['courier'] };
      await make().getDashboard(requester, {});

      const [branchCall] = calls('branch.user.find_by_branch');
      expect(branchCall[2]).toEqual({ branch_id: '16', requester });
      expect(calls('branch.user.find_by_branch')).toHaveLength(1);
    });

    it('⭐ JWT `branch_id` eskirgan (kuryer ko`chirilgan) — filial bazadan, JWT`dagi emas', async () => {
      // Token filial 9 da berilgan, keyin kuryer 16 ga ko'chirilgan.
      route();
      await make().getDashboard(
        { id: '103', roles: ['courier'], branch_id: '9' },
        {},
      );
      expect(calls('branch.user.find_by_user')).toHaveLength(1);
      const branchCalls = calls('branch.user.find_by_branch');
      expect(branchCalls).toHaveLength(1);
      expect(branchCalls[0][2]).toMatchObject({ branch_id: '16' });
    });

    it('begona filial kuryerlari (201, 202, 301) reytingda yo`q', async () => {
      route();
      const res = await make().getDashboard(
        { id: '101', roles: ['courier'] },
        {},
      );
      const ids = courierIds(res.data as Data);
      for (const outsider of ['201', '202', '301']) {
        expect(ids).not.toContain(outsider);
      }
      expect((res.data as Data).myRank).toBe(1);
    });

    it('⭐ filialga biriktirilmagan kuryer — topCouriers [], myRank null (degraded EMAS)', async () => {
      route({
        'branch.user.find_by_user': () => Promise.resolve({ data: null }),
      });
      const res = await make().getDashboard(
        { id: '201', roles: ['courier'] },
        {},
      );
      const data = res.data as Data;

      expect(data.topCouriers).toEqual([]);
      expect(data.myRank).toBeNull();
      expect(data.myRanking).toBeNull();
      expect(data.failed_parts).toEqual([]);
      // O'z statistikasi baribir bor.
      expect(data.myStat).toMatchObject({ totalOrders: 9 });
      expect(calls('branch.user.find_by_branch')).toHaveLength(0);
    });

    it('filial a`zolari olinmasa — kompaniya reytingi EMAS: [] va failed_parts: [topCouriers]', async () => {
      route({
        'branch.user.find_by_branch': () =>
          Promise.reject(new Error('branch down')),
      });
      const res = await make().getDashboard(
        { id: '103', roles: ['courier'] },
        {},
      );
      const data = res.data as Data;

      expect(data.topCouriers).toEqual([]);
      expect(data.myRank).toBeNull();
      expect(data).toMatchObject({
        degraded: true,
        failed_parts: ['topCouriers'],
      });
      expect(data.myStat).toMatchObject({ totalOrders: 9 });
    });

    it('filial aniqlanmasa (find_by_user xatosi) — 503 EMAS, reyting «olinmadi»', async () => {
      route({
        'branch.user.find_by_user': () =>
          Promise.reject(new Error('branch down')),
      });
      const res = await make().getDashboard(
        { id: '103', roles: ['courier'] },
        {},
      );
      const data = res.data as Data;
      expect(data.topCouriers).toEqual([]);
      expect(data.failed_parts).toEqual(['topCouriers']);
    });

    it('order reytingi ham, filial ham tushsa — topCouriers bir marta', async () => {
      route({
        'order.analytics.top_couriers': () =>
          Promise.reject(new Error('timeout')),
        'branch.user.find_by_branch': () =>
          Promise.reject(new Error('branch down')),
      });
      const res = await make().getDashboard(
        { id: '103', roles: ['courier'] },
        {},
      );
      expect((res.data as Data).failed_parts).toEqual(['topCouriers']);
    });
  });

  describe('menejer / registrator dashboardi `couriers` jadvali', () => {
    it.each([
      ['manager', { id: '25', roles: ['manager'] }],
      ['registrator', { id: '30', roles: ['registrator'], branch_id: '16' }],
      ['branch', { id: '31', roles: ['branch'], branch_id: '16' }],
    ])(
      '⭐ %s: faqat filial kuryerlari (begona 202 yo`q), {id, name}',
      async (_label, requester) => {
        route();
        const res = await make().getDashboard(requester, {});
        const data = res.data as Data;

        expect(data.couriers).toEqual([
          {
            courier: { id: '101', name: 'Ali' },
            totalOrders: 10,
            soldOrders: 5,
            successRate: 50,
          },
          {
            courier: { id: '103', name: 'Vali' },
            totalOrders: 10,
            soldOrders: 5,
            successRate: 50,
          },
        ]);
        expect(data.failed_parts).toEqual([]);
        expect(calls('branch.user.find_by_branch')[0][2]).toMatchObject({
          branch_id: '16',
        });
      },
    );

    it('filial a`zolari olinmasa — couriers null, failed_parts: [couriers], qolgani 200', async () => {
      route({
        'branch.user.find_by_branch': () =>
          Promise.reject(new Error('branch down')),
      });
      const res = await make().getDashboard(
        { id: '25', roles: ['manager'], branch_id: '16' },
        {},
      );
      const data = res.data as Data;
      expect(data.couriers).toBeNull();
      expect(data).toMatchObject({
        degraded: true,
        failed_parts: ['couriers'],
      });
      expect(data.orders).toMatchObject({ acceptedCount: 4 });
    });

    it('superadmin (kompaniya) va admin filial kesimi — filtr yo`q, filial a`zolari so`ralmaydi', async () => {
      route();
      const company = await make().getDashboard(
        { id: '1', roles: ['superadmin'] },
        {},
      );
      expect((company.data as Data).couriers).toHaveLength(3);

      const adminBranch = await make().getDashboard(
        { id: '2', roles: ['admin'] },
        { branch_id: '16' },
      );
      expect((adminBranch.data as Data).couriers).toHaveLength(3);
      expect(calls('branch.user.find_by_branch')).toHaveLength(0);
    });
  });

  describe('filialga biriktirilmagan filial roli — neytral dashboard', () => {
    const BRANCH_KEYS = [
      'orders',
      'markets',
      'couriers',
      'topMarkets',
      'topMarketsMeta',
      'topBranches',
      'topBranchesMeta',
      'branchDashboard',
      'targets',
      'previous',
      'series',
      'degraded',
      'failed_parts',
    ];

    it('⭐ menejer: kompaniya raqamlari EMAS — nollar, bo`sh ro`yxatlar, order`ga so`rov yo`q', async () => {
      route({
        'branch.user.find_by_user': () => Promise.resolve({ data: null }),
      });
      const res = await make().getDashboard(
        { id: '25', roles: ['manager'] },
        {},
      );
      const data = res.data as Data;

      expect(Object.keys(data).sort()).toEqual(
        [...BRANCH_KEYS, 'branch_assigned'].sort(),
      );
      expect(data.branch_assigned).toBe(false);
      expect(data.orders).toMatchObject({
        acceptedCount: 0,
        soldAndPaid: 0,
        cancelled: 0,
        profit: 0,
        totalRevenue: 0,
        lostRevenue: 0,
      });
      expect(data).toMatchObject({
        markets: [],
        couriers: [],
        topMarkets: [],
        topBranches: [],
        branchDashboard: null,
        previous: null,
        series: null,
        degraded: false,
        failed_parts: [],
      });
      expect(
        rmqSendMock.mock.calls.some(([, pattern]: [unknown, Pattern]) =>
          pattern.cmd.startsWith('order.'),
        ),
      ).toBe(false);
    });

    it('registrator: neytral javobda ham moliyaviy maydonlar yo`q', async () => {
      route({
        'branch.user.find_by_user': () => Promise.resolve({ data: null }),
      });
      const res = await make().getDashboard(
        { id: '30', roles: ['registrator'] },
        {},
      );
      const orders = (res.data as Data).orders as Record<string, unknown>;
      expect(orders.acceptedCount).toBe(0);
      for (const key of ['profit', 'totalRevenue', 'lostRevenue']) {
        expect(orders).not.toHaveProperty(key);
      }
    });

    it('filial aniqlanmasa (branch-service xatosi) — avvalgidek 503', async () => {
      route({
        'branch.user.find_by_user': () =>
          Promise.reject(new Error('branch down')),
      });
      await expect(
        make().getDashboard({ id: '25', roles: ['manager'] }, {}),
      ).rejects.toMatchObject({ error: { statusCode: 503 } });
    });

    it.each([
      ['manager', { id: '25', roles: ['manager'], branch_id: '16' }],
      ['registrator', { id: '30', roles: ['registrator'], branch_id: '16' }],
    ])(
      '⭐ %s filialdan chiqarilgan, JWT`da eski `branch_id` — eski filial raqamlari EMAS, neytral javob',
      async (_label, requester) => {
        // Token muddati tugamagan (branch_id: 16), lekin branch_users qatori
        // o'chirilgan — bazada biriktiruv yo'q.
        route({
          'branch.user.find_by_user': () => Promise.resolve({ data: null }),
        });
        const res = await make().getDashboard(requester, {});
        const data = res.data as Data;

        expect(calls('branch.user.find_by_user')).toHaveLength(1);
        expect(data.branch_assigned).toBe(false);
        expect(data.orders).toMatchObject({ acceptedCount: 0 });
        expect(
          rmqSendMock.mock.calls.some(([, pattern]: [unknown, Pattern]) =>
            pattern.cmd.startsWith('order.'),
          ),
        ).toBe(false);
      },
    );

    it('menejer boshqa filialga ko`chirilgan, JWT`da eski `branch_id` — yangi filial (bazadan)', async () => {
      route({
        'branch.user.find_by_user': () =>
          Promise.resolve({ data: { branch_id: '16' } }),
      });
      await make().getDashboard(
        { id: '25', roles: ['manager'], branch_id: '9' },
        {},
      );

      const overview = calls('order.analytics.overview');
      expect(overview).toHaveLength(1);
      expect(overview[0][2]).toMatchObject({ branch_id: '16' });
      expect(
        rmqSendMock.mock.calls.some(
          ([, , payload]: [unknown, Pattern, Record<string, unknown>]) =>
            payload?.branch_id === '9' ||
            payload?.id === '9' ||
            (payload?.filter as Record<string, unknown> | undefined)
              ?.branch_id === '9',
        ),
      ).toBe(false);
    });
  });
});
