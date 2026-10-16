/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
  Order_status: {
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

/**
 * juZFa64U — kuryerlar hisoboti (GET /analytics/reports/couriers):
 *   - kuryerlar soniga BOG'LIQ BO'LMAGAN RMQ so'rovlari: `courier_stats`
 *     ({include_detail: true}) — 1, reyting — 1; `courier_stat` (N+1) —
 *     umuman yo'q;
 *   - raqamlar eski usul bilan bir xil (har kuryer uchun alohida
 *     `courier_stat` javobidan yig'ilgani bilan solishtiriladi);
 *   - 30 s kesh TTL ishlaydi; kuryersiz va bo'sh davr xatosiz.
 */
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

type CourierRow = {
  courier: Record<string, unknown>;
  totalOrders: number;
  soldOrders: number;
  successRate: number;
  canceledOrders?: number;
  profit?: number;
};

function couriers(n: number): CourierRow[] {
  return Array.from({ length: n }, (_, i) => {
    const total = 10 + i;
    const sold = 5 + (i % 4);
    return {
      courier: { id: String(300 + i), name: `Kuryer ${i}`, salary: 9_999 },
      totalOrders: total,
      soldOrders: sold,
      successRate: Number(((sold * 100) / total).toFixed(2)),
      canceledOrders: 1 + (i % 3),
      profit: 30_000 * sold,
    };
  });
}

function route(rows: CourierRow[]) {
  rmqSendMock.mockImplementation((_client: unknown, pattern: any) => {
    switch (pattern?.cmd) {
      case 'order.analytics.courier_stats':
        return Promise.resolve({ data: rows });
      case 'order.analytics.top_couriers':
        return Promise.resolve({ data: { items: [], meta: null } });
      case 'order.analytics.courier_stat':
        throw new Error('N+1 courier_stat chaqirilmasligi kerak');
      default:
        return Promise.resolve({ data: null });
    }
  });
}

const cmds = () =>
  rmqSendMock.mock.calls.map(([, pattern]: any[]) => pattern?.cmd as string);

/** Eski yo'l (4dfb0ec gacha): har kuryerga `courier_stat` → shu item. */
function legacyItem(
  row: CourierRow,
  detail: { canceledOrders?: number; profit?: number } | null,
) {
  const parse = (value: unknown, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    courier: { id: String(row.courier.id), name: row.courier.name },
    deliveredOrders: parse(row.soldOrders),
    cancelledOrders:
      detail?.canceledOrders === undefined
        ? Math.max(0, parse(row.totalOrders) - parse(row.soldOrders))
        : parse(detail.canceledOrders),
    averageDeliveryHours: null,
    totalAmount: parse(detail?.profit),
    salaryEstimate: parse(detail?.profit),
    successRate: parse(row.successRate),
  };
}

describe('juZFa64U — kuryerlar hisoboti bitta so`rovda', () => {
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
    jest.restoreAllMocks();
  });

  it.each([1, 8, 50])(
    '⭐ %i kuryer — RMQ so`rovlari soni o`zgarmas (courier_stats 1, reyting 1), courier_stat yo`q',
    async (n) => {
      route(couriers(n));

      const res: any = await service.getCourierReport(
        SUPERADMIN as any,
        {
          fromDate: '2026-06-01',
          toDate: '2026-09-19',
        } as any,
      );

      expect(res.data.items).toHaveLength(n);
      expect(cmds().sort()).toEqual([
        'order.analytics.courier_stats',
        'order.analytics.top_couriers',
      ]);
      const statsCall = rmqSendMock.mock.calls.find(
        ([, pattern]: any[]) =>
          pattern?.cmd === 'order.analytics.courier_stats',
      );
      expect(statsCall[2]).toMatchObject({ include_detail: true });
    },
  );

  it('⭐ raqamlar o`zgarishsiz — eski usul (har kuryerga courier_stat) natijasi bilan AYNAN teng', async () => {
    const rows = couriers(8);
    route(rows);

    const res: any = await service.getCourierReport(
      SUPERADMIN as any,
      {
        fromDate: '2026-06-01',
        toDate: '2026-09-19',
      } as any,
    );

    const expected = rows.map((row) =>
      legacyItem(row, {
        canceledOrders: row.canceledOrders,
        profit: row.profit,
      }),
    );
    expect(res.data.items).toEqual(expected);
    // CODE-08 o'zgarmagan: kuryer faqat {id, name}.
    for (const item of res.data.items) {
      expect(Object.keys(item.courier).sort()).toEqual(['id', 'name']);
    }
  });

  it('eski order-service (qatorda detail yo`q) — eski zaxira: bekor = jami − sotilgan, daromad 0', async () => {
    const rows = couriers(3).map((row) => {
      const rest: Record<string, unknown> = { ...row };
      delete rest.canceledOrders;
      delete rest.profit;
      return rest;
    });
    route(rows);

    const res: any = await service.getCourierReport(
      SUPERADMIN as any,
      {} as any,
    );

    expect(res.data.items).toEqual(rows.map((row) => legacyItem(row, null)));
  });

  it('⭐ 30 s kesh: TTL ichida qayta RMQ yo`q, TTL o`tgach qayta yig`iladi', async () => {
    route(couriers(4));
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const filter = { fromDate: '2026-06-01', toDate: '2026-06-30' } as any;

    await service.getCourierReport(SUPERADMIN as any, filter);
    expect(cmds()).toHaveLength(2);

    now += 29_999;
    const cachedRes: any = await service.getCourierReport(
      { id: '301', roles: ['courier'] } as any,
      filter,
    );
    expect(cmds()).toHaveLength(2);
    expect(cachedRes.data.items.map((i: any) => i.courier.id)).toEqual(['301']);

    now += 2;
    await service.getCourierReport(SUPERADMIN as any, filter);
    expect(cmds()).toHaveLength(4);
  });

  it.each([
    ["kuryeri yo'q", { data: [] }],
    ["bo'sh javob (data null)", { data: null }],
  ])('%s / bo`sh davr — xatosiz, bo`sh items', async (_l, reply) => {
    rmqSendMock.mockImplementation((_client: unknown, pattern: any) =>
      Promise.resolve(
        pattern?.cmd === 'order.analytics.courier_stats'
          ? reply
          : { data: { items: [], meta: null } },
      ),
    );

    const res: any = await service.getCourierReport(
      SUPERADMIN as any,
      {
        fromDate: '2030-01-01',
        toDate: '2030-01-02',
      } as any,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.items).toEqual([]);
    expect(cmds()).not.toContain('order.analytics.courier_stat');
  });
});
