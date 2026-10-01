import { AnalyticsServiceService } from './analytics-service.service';

/**
 * FIX3 (A7) — analytics data scoping:
 *  - RBAC-02: market dashboard `markets` = faqat so'rovchi marketning o'z
 *    qatori, market obyekti {id, name};
 *  - CODE-08: dashboard market/kuryer qatorlari {id, name} gacha qisqaradi;
 *    reports/couriers menejer/registrator uchun o'z filiali bilan cheklangan;
 *  - CODE-22: moliya hisobotining oylik kaliti Toshkent oyi.
 */

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
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

/** identity sanitize() dan keladigan to'liq market qatori (sirlarsiz). */
const fullMarket = (id: string, name: string) => ({
  id,
  name,
  phone_number: `+99890000${id}`,
  username: `market_${id}`,
  tariff_home: 30000,
  tariff_center: 20000,
  default_tariff: 'center',
  address: 'Toshkent',
  telegram_id: '123',
  settings: { theme: 'dark' },
  commission_type: null,
  commission_value: null,
});

const fullCourier = (id: string, name: string) => ({
  id,
  name,
  phone_number: `+99891000${id}`,
  salary: 3_000_000,
  tariff_home: 15000,
  tariff_center: 10000,
  commission_type: 'fixed',
  commission_value: 5000,
});

const marketStatsRows = () => [
  {
    market: fullMarket('5', 'Beshinchi'),
    totalOrders: 40,
    soldOrders: 30,
    sellingRate: 75,
  },
  {
    market: fullMarket('7', 'Yettinchi'),
    totalOrders: 10,
    soldOrders: 2,
    sellingRate: 20,
  },
];

const SENSITIVE_KEYS = [
  'phone_number',
  'username',
  'tariff_home',
  'tariff_center',
  'default_tariff',
  'address',
  'telegram_id',
  'settings',
  'salary',
  'commission_type',
  'commission_value',
];

const cmdsSent = () =>
  rmqSendMock.mock.calls.map(([, pattern]) => pattern?.cmd as string);

describe('FIX3 A7 — analytics scoping', () => {
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

  describe('RBAC-02: market dashboard', () => {
    const route = (identityMarketId: string | null) =>
      rmqSendMock.mockImplementation((_client: any, pattern: any) => {
        switch (pattern?.cmd) {
          case 'order.analytics.market_stat':
            return Promise.resolve({ data: { totalOrders: 40 } });
          case 'order.analytics.market_stats':
            return Promise.resolve({ data: marketStatsRows() });
          case 'order.analytics.top_markets':
            return Promise.resolve({
              data: [{ market_id: '5', market_name: 'Beshinchi' }],
            });
          case 'order.analytics.top_operators_by_market':
            return Promise.resolve({ data: [] });
          case 'identity.user.find_by_id':
            return Promise.resolve({ data: { market_id: identityMarketId } });
          default:
            return Promise.resolve({ data: null });
        }
      });

    it("market faqat o'z qatorini {id, name} bilan ko'radi — boshqa marketlar yo'q", async () => {
      route(null);

      const res = await service.getDashboard(
        { id: '5', roles: ['market'] },
        {} as any,
      );

      expect(res.data.markets).toEqual([
        {
          market: { id: '5', name: 'Beshinchi' },
          totalOrders: 40,
          soldOrders: 30,
          sellingRate: 75,
        },
      ]);
      const serialized = JSON.stringify(res.data.markets);
      expect(serialized).not.toContain('Yettinchi');
      for (const key of SENSITIVE_KEYS) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      // Leaderboard (faqat id/nom/son) o'zgarmagan.
      expect(res.data.topMarkets).toEqual([
        { market_id: '5', market_name: 'Beshinchi' },
      ]);
    });

    it("?all=true ham faqat o'z qatorini beradi", async () => {
      route(null);

      const res = await service.getDashboard(
        { id: '7', roles: ['market'] },
        { all: true },
      );

      expect(res.data.markets).toHaveLength(1);
      expect(res.data.markets[0].market).toEqual({
        id: '7',
        name: 'Yettinchi',
      });
    });

    it("market operatori o'zining marketi qatorini ko'radi", async () => {
      route('7');

      const res = await service.getDashboard(
        { id: '900', roles: ['market_operator'] },
        {} as any,
      );

      expect(res.data.markets).toEqual([
        expect.objectContaining({ market: { id: '7', name: 'Yettinchi' } }),
      ]);
    });

    it("marketi aniqlanmagan operator — bo'sh ro'yxat (fail-closed)", async () => {
      route(null);

      const res = await service.getDashboard(
        { id: '900', roles: ['market_operator'] },
        {} as any,
      );

      expect(res.data.markets).toEqual([]);
    });

    it("market_stats xato bersa — bo'sh ro'yxat, dashboard yiqilmaydi", async () => {
      rmqSendMock.mockImplementation((_client: any, pattern: any) =>
        pattern?.cmd === 'order.analytics.market_stats'
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve({ data: null }),
      );

      const res = await service.getDashboard(
        { id: '5', roles: ['market'] },
        {} as any,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.markets).toEqual([]);
    });
  });

  describe('CODE-08: admin/filial dashboard qatorlari {id, name}', () => {
    const route = () =>
      rmqSendMock.mockImplementation((_client: any, pattern: any) => {
        switch (pattern?.cmd) {
          case 'order.analytics.market_stats':
            return Promise.resolve({ data: marketStatsRows() });
          case 'order.analytics.courier_stats':
            return Promise.resolve({
              data: [
                {
                  courier: fullCourier('31', 'Ali'),
                  totalOrders: 8,
                  soldOrders: 6,
                  successRate: 75,
                },
              ],
            });
          case 'branch.dashboard':
            return Promise.resolve({ data: { branchId: '16' } });
          default:
            return Promise.resolve({ data: [] });
        }
      });

    it.each([
      ['superadmin', { id: '1', roles: ['superadmin'] }],
      ['manager', { id: '2', roles: ['manager'], branch_id: '16' }],
      ['registrator', { id: '3', roles: ['registrator'], branch_id: '16' }],
    ])(
      '%s: market va kuryer obyektlarida sir maydonlar yo‘q',
      async (_l, requester) => {
        route();

        const res = await service.getDashboard(requester as any, {} as any);

        expect(res.data.markets).toEqual([
          {
            market: { id: '5', name: 'Beshinchi' },
            totalOrders: 40,
            soldOrders: 30,
            sellingRate: 75,
          },
          {
            market: { id: '7', name: 'Yettinchi' },
            totalOrders: 10,
            soldOrders: 2,
            sellingRate: 20,
          },
        ]);
        expect(res.data.couriers).toEqual([
          {
            courier: { id: '31', name: 'Ali' },
            totalOrders: 8,
            soldOrders: 6,
            successRate: 75,
          },
        ]);
        const serialized = JSON.stringify([
          res.data.markets,
          res.data.couriers,
        ]);
        for (const key of SENSITIVE_KEYS) {
          expect(serialized).not.toContain(`"${key}"`);
        }
      },
    );

    it('downstream xatosi (null) o‘z holicha qaytadi', async () => {
      rmqSendMock.mockRejectedValue(new Error('timeout'));

      const res = await service.getDashboard(
        { id: '1', roles: ['superadmin'] },
        {} as any,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.markets).toBeNull();
      expect(res.data.couriers).toBeNull();
    });
  });

  describe('CODE-08 / C11: reports/couriers filial bilan cheklangan', () => {
    const courierStats = [
      {
        courier: fullCourier('31', 'Ali'),
        soldOrders: 6,
        totalOrders: 8,
        successRate: 75,
      },
      {
        courier: fullCourier('32', 'Vali'),
        soldOrders: 1,
        totalOrders: 4,
        successRate: 25,
      },
      {
        courier: fullCourier('77', 'Boshqa filial'),
        soldOrders: 9,
        totalOrders: 9,
        successRate: 100,
      },
    ];
    const ranking = [
      { courier_id: '77', courier_name: 'Boshqa filial', success_rate: 100 },
      { courier_id: '31', courier_name: 'Ali', success_rate: 75 },
    ];

    const route = (branchUsers: unknown) =>
      rmqSendMock.mockImplementation(
        (_client: any, pattern: any, payload: any) => {
          switch (pattern?.cmd) {
            case 'order.analytics.courier_stats':
              return Promise.resolve({ data: courierStats });
            case 'order.analytics.top_couriers':
              return Promise.resolve({ data: ranking });
            case 'order.analytics.courier_stat':
              return Promise.resolve({
                data: {
                  profit: 1000 * Number(payload.requester.id),
                  canceledOrders: 0,
                },
              });
            case 'branch.user.find_by_branch':
              expect(payload.branch_id).toBe('16');
              return typeof branchUsers === 'function'
                ? (branchUsers as () => Promise<unknown>)()
                : Promise.resolve({ data: branchUsers });
            case 'branch.user.find_by_user':
              return Promise.resolve({ data: { branch_id: '16' } });
            default:
              return Promise.resolve({ data: null });
          }
        },
      );

    const ownBranchUsers = [
      { user_id: '31', role: 'COURIER' },
      { user_id: '32', role: 'courier' },
      { user_id: '2', role: 'MANAGER' },
    ];

    it.each([
      ['manager', { id: '2', roles: ['manager'], branch_id: '16' }],
      ['registrator', { id: '3', roles: ['registrator'], branch_id: '16' }],
      ['branch', { id: '4', roles: ['branch'], branch_id: '16' }],
    ])("%s faqat o'z filiali kuryerlarini ko'radi", async (_l, requester) => {
      route(ownBranchUsers);

      const res = await service.getCourierReport(requester as any, {} as any);

      expect(res.data.items.map((row: any) => row.courier)).toEqual([
        { id: '31', name: 'Ali' },
        { id: '32', name: 'Vali' },
      ]);
      expect(res.data.ranking).toEqual([
        { courier_id: '31', courier_name: 'Ali', success_rate: 75 },
      ]);
      expect(JSON.stringify(res.data)).not.toContain('Boshqa filial');
      expect(JSON.stringify(res.data.items)).not.toContain('"salary"');
    });

    it("branch_id JWT'da bo'lmasa — branch.user.find_by_user orqali aniqlanadi", async () => {
      route(ownBranchUsers);

      const res = await service.getCourierReport(
        { id: '2', roles: ['manager'] },
        {} as any,
      );

      expect(cmdsSent()).toContain('branch.user.find_by_user');
      expect(res.data.items).toHaveLength(2);
    });

    it.each([
      ['branch-service xato bersa', () => Promise.reject(new Error('down'))],
      ["filialda kuryer yo'q", []],
    ])("%s — bo'sh hisobot, og'ir hisob boshlanmaydi", async (_l, users) => {
      route(users);

      const res = await service.getCourierReport(
        { id: '2', roles: ['manager'], branch_id: '16' },
        {} as any,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.items).toEqual([]);
      expect(res.data.ranking).toEqual([]);
      expect(cmdsSent()).not.toContain('order.analytics.courier_stats');
    });

    it("requester'siz chaqiruv — bo'sh (kompaniya bo'yicha ro'yxat chiqmaydi)", async () => {
      route(ownBranchUsers);

      const res = await service.getCourierReport(undefined, {} as any);

      expect(res.data.items).toEqual([]);
    });

    it("superadmin hammasini ko'radi, kuryer obyekti baribir {id, name}", async () => {
      route(ownBranchUsers);

      const res = await service.getCourierReport(
        { id: '1', roles: ['superadmin'] },
        {} as any,
      );

      expect(res.data.items).toHaveLength(3);
      expect(res.data.ranking).toHaveLength(2);
      expect(res.data.items[2].courier).toEqual({
        id: '77',
        name: 'Boshqa filial',
      });
      expect(cmdsSent()).not.toContain('branch.user.find_by_branch');
    });

    it("kuryer faqat o'zini ko'radi (o'zgarmagan)", async () => {
      route(ownBranchUsers);

      const res = await service.getCourierReport(
        { id: '32', roles: ['courier'] },
        {} as any,
      );

      expect(res.data.items).toEqual([
        expect.objectContaining({ courier: { id: '32', name: 'Vali' } }),
      ]);
      expect(cmdsSent()).not.toContain('branch.user.find_by_branch');
    });
  });

  describe('CODE-22: moliya hisobotining oylik kaliti Toshkent oyi', () => {
    it("Toshkent 1-oktabr 00:30 dagi kirim oktabrga tushadi (UTC'da hali sentabr)", async () => {
      rmqSendMock.mockImplementation((_client: any, pattern: any) => {
        if (pattern.cmd === 'finance.cashbox.all_info') {
          return Promise.resolve({
            data: {
              allCashboxHistories: [
                {
                  operation_type: 'income',
                  amount: 500,
                  createdAt: '2026-09-30T19:30:00.000Z',
                },
                {
                  operation_type: 'expense',
                  amount: 200,
                  createdAt: '2026-09-30T18:59:59.000Z',
                },
              ],
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const res = await service.getFinanceReport(
        { id: '1', roles: ['admin'] },
        {} as any,
      );

      expect(res.data.monthlyDynamics).toEqual([
        { month: '2026-09', amount: -200 },
        { month: '2026-10', amount: 500 },
      ]);
    });
  });
});
