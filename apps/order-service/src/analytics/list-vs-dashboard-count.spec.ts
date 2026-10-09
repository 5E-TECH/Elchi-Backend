import {
  Order_status,
  endOfTashkentDay,
  parseDateOnly,
  startOfTashkentDay,
} from '@app/common';
import { OrderServiceService } from '../order-service.service';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * SqVMuhKo (2026-10-09 prod UI test — FAIL). Kun chegarasi Toshkentga
 * o'tkazilgandan keyin ham buyurtmalar ro'yxati (`findAll`, sana filtri) va
 * dashboard «Jami qabul qilingan» bir xil sana uchun TURLI son berardi:
 * 08.10 da 10 vs 9, 01–09.10 da 39 vs 37.
 *
 * Sabab — qisman sotuvdan hosil bo'lgan bola-buyurtma (`parent_order_id`,
 * prod'da #29 → #25, #20 → #17). Ro'yxat uni alohida qator sanaydi (u
 * haqiqatan alohida qator: o'z QR'i, kuryer/filial egaligi va qaytarish
 * yo'li bor), dashboard esa `COUNT(DISTINCT COALESCE(parent_order_id, id))`
 * bilan ota bilan BITTA sanardi.
 *
 * Bu spec ikkala yo'lning HAQIQIY so'rov qurish mantiqini kichik xotiradagi
 * baholovchi orqali bitta qatorlar to'plamiga qo'llaydi: qo'shilgan WHERE
 * shartlari va SELECT ifodasi shu yerda bajariladi. Noma'lum shart yoki
 * ifoda — xato (so'rov o'zgarsa spec jim o'tib ketmasin).
 */

type OrderRow = {
  id: string;
  parent_order_id: string | null;
  isDeleted: boolean;
  createdAt: Date;
  status: Order_status;
  sold_at: string | null;
  total_price: number;
};

type TrackingRow = {
  order_id: string;
  to_status: Order_status;
  action: string | null;
  created_at: Date;
};

type JoinedTracking = { t: TrackingRow; o: OrderRow };
type Params = Record<string, any>;
type Predicate<T> = (row: T) => boolean;
type SelectEvaluator<T> = (expr: string, rows: T[]) => number;

/** Toshkent mahalliy vaqti → Date ('2026-10-08T02:30' = 08.10 02:30 TSH). */
const tsh = (local: string) => new Date(`${local}:00+05:00`);
const ms = (date: Date) => String(date.getTime());

class FakeQueryBuilder<T> {
  private predicates: Predicate<T>[] = [];
  private selects: Array<{ expr: string; alias?: string }> = [];

  constructor(
    private readonly rows: T[],
    private readonly compile: (sql: string, params: Params) => Predicate<T>,
    private readonly evaluate: SelectEvaluator<T>,
  ) {}

  where(sql: unknown, params: Params = {}) {
    if (typeof sql !== 'string') {
      throw new Error(`SqVMuhKo fake: satr bo'lmagan shart (${typeof sql})`);
    }
    this.predicates.push(this.compile(sql, params));
    return this;
  }

  andWhere(sql: unknown, params: Params = {}) {
    return this.where(sql, params);
  }

  select(expr: string, alias?: string) {
    this.selects = [{ expr, alias }];
    return this;
  }

  addSelect(expr: string, alias?: string) {
    this.selects.push({ expr, alias });
    return this;
  }

  // Natijaga ta'sir qilmaydigan bo'g'inlar (join, saralash, sahifa).
  innerJoin() {
    return this;
  }
  leftJoin() {
    return this;
  }
  leftJoinAndSelect() {
    return this;
  }
  orderBy() {
    return this;
  }
  addOrderBy() {
    return this;
  }
  skip() {
    return this;
  }
  take() {
    return this;
  }

  clone() {
    const copy = new FakeQueryBuilder<T>(
      this.rows,
      this.compile,
      this.evaluate,
    );
    copy.predicates = [...this.predicates];
    copy.selects = [...this.selects];
    return copy;
  }

  private matched() {
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }

  getCount() {
    return Promise.resolve(this.matched().length);
  }

  getMany() {
    return Promise.resolve(this.matched());
  }

  getRawOne() {
    const rows = this.matched();
    return Promise.resolve(
      Object.fromEntries(
        this.selects.map(({ expr, alias }) => [
          alias ?? expr,
          String(this.evaluate(expr, rows)),
        ]),
      ),
    );
  }
}

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const inRange = (value: number, from: unknown, to: unknown) =>
  value >= new Date(from as Date).getTime() &&
  value <= new Date(to as Date).getTime();

function compileOrderPredicate(sql: string, p: Params): Predicate<OrderRow> {
  // `findAll` aliasi — `order`, analitikaniki — `o`.
  const s = normalizeSql(sql).replace(/\b(order|o)\./g, '');
  switch (s) {
    case 'isDeleted = :isDeleted':
      return (r) => r.isDeleted === p.isDeleted;
    case 'createdAt >= :startDate':
      return (r) => r.createdAt.getTime() >= p.startDate.getTime();
    case 'createdAt <= :endDate':
      return (r) => r.createdAt.getTime() <= p.endDate.getTime();
    case 'createdAt BETWEEN :start AND :end':
      return (r) => inRange(r.createdAt.getTime(), p.start, p.end);
    case 'status IN (:...statuses)':
      return (r) => (p.statuses as Order_status[]).includes(r.status);
    case 'sold_at BETWEEN :startMs AND :endMs':
      return (r) =>
        r.sold_at !== null &&
        Number(r.sold_at) >= Number(p.startMs) &&
        Number(r.sold_at) <= Number(p.endMs);
    default:
      throw new Error(`SqVMuhKo fake: noma'lum buyurtma sharti "${sql}"`);
  }
}

const PROFIT_SQL = (OrderAnalyticsService as any).PROFIT_SQL as string;

function evaluateOrderSelect(expr: string, rows: OrderRow[]): number {
  switch (normalizeSql(expr)) {
    case 'COUNT(*)':
      return rows.length;
    // Tuzatishdan OLDINGI dashboard ifodasi — spec qizil ekanini ko'rsatish
    // uchun baholovchida qoldirilgan.
    case 'COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))':
      return new Set(rows.map((r) => r.parent_order_id ?? r.id)).size;
    case 'COALESCE(SUM(o.total_price), 0)':
      return rows.reduce((sum, r) => sum + r.total_price, 0);
    case normalizeSql(PROFIT_SQL):
      return 0;
    default:
      throw new Error(`SqVMuhKo fake: noma'lum SELECT "${expr}"`);
  }
}

function compileTrackingPredicate(
  sql: string,
  p: Params,
): Predicate<JoinedTracking> {
  switch (normalizeSql(sql)) {
    case 'o.isDeleted = :isDeleted':
      return ({ o }) => o.isDeleted === p.isDeleted;
    case 't.to_status IN (:...statuses)':
      return ({ t }) => (p.statuses as Order_status[]).includes(t.to_status);
    case '(t.action IS NULL OR t.action != :cancelledPostReceived)':
      return ({ t }) =>
        t.action === null || t.action !== p.cancelledPostReceived;
    case 't.created_at BETWEEN :start AND :end':
      return ({ t }) => inRange(t.created_at.getTime(), p.start, p.end);
    default:
      throw new Error(`SqVMuhKo fake: noma'lum kuzatuv sharti "${sql}"`);
  }
}

function evaluateTrackingSelect(expr: string, rows: JoinedTracking[]) {
  if (normalizeSql(expr) === 'COUNT(DISTINCT t.order_id)') {
    return new Set(rows.map(({ t }) => t.order_id)).size;
  }
  throw new Error(`SqVMuhKo fake: noma'lum kuzatuv SELECT "${expr}"`);
}

function setup(orders: OrderRow[], tracking: TrackingRow[] = []) {
  const orderRepo = {
    createQueryBuilder: jest.fn(
      () =>
        new FakeQueryBuilder<OrderRow>(
          orders,
          compileOrderPredicate,
          evaluateOrderSelect,
        ),
    ),
  };
  const joined: JoinedTracking[] = tracking.map((t) => {
    const o = orders.find((row) => row.id === t.order_id);
    if (!o) throw new Error(`SqVMuhKo fake: #${t.order_id} buyurtmasi yo'q`);
    return { t, o };
  });
  const orderTrackingRepo = {
    createQueryBuilder: jest.fn(
      () =>
        new FakeQueryBuilder<JoinedTracking>(
          joined,
          compileTrackingPredicate,
          evaluateTrackingSelect,
        ),
    ),
  };
  // Filial doirasi bu specda ishlatilmaydi — faqat sub-so'rov matni quriladi.
  const custodyQb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getQuery: jest.fn().mockReturnValue('SELECT 1'),
  };
  const orderCustodyEventRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(custodyQb),
  };

  const none = {} as any;
  const service = new OrderServiceService(
    none, // dataSource
    orderRepo as any,
    none, // orderItemRepo
    orderTrackingRepo as any,
    orderCustodyEventRepo as any,
    none, // orderSettlementRepo
    none, // transferBatchRepo
    none, // transferBatchItemRepo
    none, // transferBatchHistoryRepo
    none, // searchClient
    none, // identityClient
    none, // logisticsClient
    none, // catalogClient
    none, // financeClient
    none, // integrationClient
    none, // branchClient
    none, // fileClient
    none, // outbox
    none, // activityLog
    none, // lookup
    none, // custody
  );
  const analytics = new OrderAnalyticsService(
    orderRepo as any,
    orderTrackingRepo as any,
    orderCustodyEventRepo as any,
    none, // identityClient
    none, // branchClient
    none, // logisticsClient
    none, // lookup
  );

  /** GET /orders?start_day&end_day → `total` (ro'yxat sarlavhasidagi son). */
  const listTotal = async (startDay: string, endDay: string) => {
    const res = (await service.findAll({
      start_day: startDay,
      end_day: endDay,
      page: 1,
      limit: 10,
    })) as { total: number };
    return res.total;
  };

  /**
   * GET /analytics/dashboard?start_day&end_day → `orders`. analytics-service
   * `normalizeDateRange` bilan AYNI: Toshkent kuni chegaralari ISO bo'lib
   * `order.analytics.overview` ga boradi.
   */
  const dashboard = async (startDay: string, endDay: string) => {
    const start = startOfTashkentDay(parseDateOnly(startDay)!);
    const end = endOfTashkentDay(parseDateOnly(endDay)!);
    return analytics.getOverviewStats(start.toISOString(), end.toISOString());
  };

  return { listTotal, dashboard };
}

const order = (
  id: string,
  createdLocal: string,
  extra: Partial<OrderRow> = {},
): OrderRow => ({
  id,
  parent_order_id: null,
  isDeleted: false,
  createdAt: tsh(createdLocal),
  status: Order_status.WAITING,
  sold_at: null,
  total_price: 100_000,
  ...extra,
});

/**
 * Prod holatining nusxasi (#17/#20, #25/#29) + chekka holatlar:
 * tungi buyurtma, o'chirilgan buyurtma va kunlararo qisman sotuv.
 */
function fixture() {
  const orders: OrderRow[] = [
    // 07.10 — ota #17 va uning qisman sotuv bolasi #20 (ayni kun).
    order('17', '2026-10-07T11:00', {
      status: Order_status.SOLD,
      sold_at: ms(tsh('2026-10-07T17:59')),
    }),
    order('20', '2026-10-07T18:00', {
      parent_order_id: '17',
      status: Order_status.CANCELLED,
      total_price: 40_000,
    }),
    // 08.10 — ota #25 va bola #29 (prod'dagi 10 vs 9 farqining aynan o'zi).
    order('25', '2026-10-08T10:00', {
      status: Order_status.SOLD,
      sold_at: ms(tsh('2026-10-08T15:59')),
    }),
    order('29', '2026-10-08T16:00', {
      parent_order_id: '25',
      status: Order_status.CANCELLED,
      total_price: 30_000,
    }),
    // Toshkent 02:30 — UTC bo'yicha 07.10, lekin ikkala ekranda 08.10.
    order('30', '2026-10-08T02:30'),
    // O'chirilgan — ikkalasida ham sanalmaydi.
    order('31', '2026-10-08T12:00', { isDeleted: true }),
    // Kunlararo: #32 08.10 da yaratilgan, 09.10 da qisman sotilgan (#40).
    order('32', '2026-10-08T20:00', {
      status: Order_status.SOLD,
      sold_at: ms(tsh('2026-10-09T08:59')),
    }),
    order('40', '2026-10-09T09:00', {
      parent_order_id: '32',
      status: Order_status.CANCELLED,
      total_price: 20_000,
    }),
    order('41', '2026-10-09T13:00'),
  ];
  // Qisman sotuvda bola `to_status = CANCELLED`, action 'partly_sold' bilan
  // yoziladi (`partlySellOrder` → `inferTrackingAction`).
  const tracking: TrackingRow[] = [
    {
      order_id: '20',
      to_status: Order_status.CANCELLED,
      action: 'partly_sold',
      created_at: tsh('2026-10-07T18:00'),
    },
    {
      order_id: '29',
      to_status: Order_status.CANCELLED,
      action: 'partly_sold',
      created_at: tsh('2026-10-08T16:00'),
    },
    {
      order_id: '40',
      to_status: Order_status.CANCELLED,
      action: 'partly_sold',
      created_at: tsh('2026-10-09T09:00'),
    },
  ];
  return { orders, tracking };
}

describe('SqVMuhKo — ro`yxat va dashboard bir xil sana uchun bir xil son', () => {
  it.each([
    ['2026-10-07', '2026-10-07', 2],
    ['2026-10-08', '2026-10-08', 4],
    ['2026-10-09', '2026-10-09', 2],
    ['2026-10-07', '2026-10-09', 8],
  ])(
    '%s … %s: ro`yxat total === dashboard «Jami qabul qilingan» (%i)',
    async (startDay, endDay, expected) => {
      const { orders, tracking } = fixture();
      const { listTotal, dashboard } = setup(orders, tracking);

      const total = await listTotal(startDay, endDay);
      const overview = await dashboard(startDay, endDay);

      expect(total).toBe(expected);
      expect(overview.acceptedCount).toBe(total);
      // Frontend adapterlari o'qiydigan sinonimlar ham ayni son.
      expect(overview.total).toBe(total);
      expect(overview.totalOrders).toBe(total);
      expect(overview.ordersCount).toBe(total);
    },
  );

  it('ota + bola ayni kunda: «Jarayonda» (jami − sotilgan − bekor) manfiy chiqmaydi', async () => {
    // Dashboard bekor sonida bola-buyurtma ALLAQACHON alohida sanaladi
    // (kuzatuvda CANCELLED). Jami uni sanamasa: 1 − 1 − 1 = −1 → frontend
    // 0 ga qirqardi, sotish + bekor ulushi 200% bo'lardi.
    const { orders, tracking } = fixture();
    const { dashboard } = setup(
      orders.filter((o) => o.id === '25' || o.id === '29'),
      tracking.filter((t) => t.order_id === '29'),
    );

    const overview = await dashboard('2026-10-08', '2026-10-08');

    expect(overview.soldAndPaid).toBe(1);
    expect(overview.cancelled).toBe(1);
    expect(overview.acceptedCount).toBe(2);
    expect(
      overview.acceptedCount - overview.soldAndPaid - overview.cancelled,
    ).toBe(0);
  });
});
