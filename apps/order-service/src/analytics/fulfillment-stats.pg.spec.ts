import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderAnalyticsService } from './order-analytics.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';

/**
 * (mKS1mjNr) `getFulfillmentStats` — HAQIQIY Postgres'da eski JS hisobi
 * (analytics-service `getKpiStats`: `order.find_all` sahifalari + `sold_at −
 * createdAt` tsikli) bilan AYNAN bir xil natija beradimi.
 *
 * Faqat lokal test bazasida ishlaydi (prod/umumiy baza emas):
 *   ORDER_FULFILLMENT_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_e_kpi
 */
const uri = process.env.ORDER_FULFILLMENT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_kpi'
  );
})();

const HOUR = 60 * 60 * 1000;
const SOLD_LIKE = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.CLOSED,
  Order_status.PARTLY_PAID,
];

/** Eski analytics-service hisobining (4dfb0ec gacha) aynan nusxasi. */
function legacyFulfillment(
  orders: Array<{ createdAt: Date; sold_at: string | null }>,
) {
  let deliveryMsTotal = 0;
  let deliveryCount = 0;
  let onTimeCount = 0;
  const SLA_MS = 24 * HOUR;
  for (const order of orders) {
    const createdAt = new Date(order.createdAt);
    const soldAt = order?.sold_at ? new Date(Number(order.sold_at)) : null;
    if (!createdAt || !soldAt || Number.isNaN(soldAt.getTime())) continue;
    const diff = soldAt.getTime() - createdAt.getTime();
    if (diff > 0) {
      deliveryMsTotal += diff;
      deliveryCount += 1;
      if (diff <= SLA_MS) onTimeCount += 1;
    }
  }
  return {
    averageFulfillmentHours:
      deliveryCount > 0
        ? Number((deliveryMsTotal / deliveryCount / HOUR).toFixed(2))
        : 0,
    onTimeRate:
      deliveryCount > 0
        ? Number(((onTimeCount * 100) / deliveryCount).toFixed(2))
        : 0,
    deliveryCount,
  };
}

/** analytics-service yangi hisobi (`getKpiStats`) — SQL agregatidan. */
function kpiFromAggregate(row: {
  deliveredCount: number;
  deliveryMsTotal: number;
  onTimeCount: number;
}) {
  return {
    averageFulfillmentHours:
      row.deliveredCount > 0
        ? Number((row.deliveryMsTotal / row.deliveredCount / HOUR).toFixed(2))
        : 0,
    onTimeRate:
      row.deliveredCount > 0
        ? Number(((row.onTimeCount * 100) / row.deliveredCount).toFixed(2))
        : 0,
    deliveryCount: row.deliveredCount,
  };
}

(localTestDatabase ? describe : describe.skip)(
  'mKS1mjNr — fulfillment SQL agregati (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let analytics: OrderAnalyticsService;
    let schemasCreated = false;

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'order_schema',
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: false,
      });
      await db.initialize();
      for (const schema of ['order_schema', 'branch_schema']) {
        await db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      }
      schemasCreated = true;
      await db.synchronize();
      analytics = new OrderAnalyticsService(
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemasCreated) {
          for (const schema of ['order_schema', 'branch_schema']) {
            await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          }
        }
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    beforeEach(async () => {
      await db.query('TRUNCATE order_schema.orders CASCADE');
    });

    /** Eski yo'l bilan bir xil tanlov: o'chirilmagan, 4 status, createdAt oynada. */
    async function legacyRows(start: string, end: string) {
      return db.query<Array<{ createdAt: Date; sold_at: string | null }>>(
        `SELECT "createdAt", sold_at FROM order_schema.orders
          WHERE is_deleted = false AND status = ANY($1)
            AND "createdAt" >= $2 AND "createdAt" <= $3`,
        [SOLD_LIKE, start, end],
      );
    }

    it('⭐ TC3/TC4/TC6: o`rtacha soat va SLA ulushi eski JS hisobi bilan AYNAN bir xil (chekka holatlar bilan)', async () => {
      // 01.09–30.09 (Toshkent) oynasi.
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", sold_at, is_deleted)
        SELECT 1, 2,
          (ARRAY['sold','paid','closed','partly_paid','cancelled','new'])[1 + (n % 6)]::order_schema.orders_status_enum,
          ts,
          CASE
            WHEN n % 17 = 0 THEN NULL                                  -- sold_at yo'q
            WHEN n % 19 = 0 THEN 0                                     -- sold_at = 0
            WHEN n % 23 = 0 THEN (EXTRACT(EPOCH FROM ts) * 1000)::bigint - 3600000  -- manfiy farq
            ELSE (EXTRACT(EPOCH FROM ts) * 1000)::bigint + ((n * 7919) % (96 * 3600000)) + (n % 1000)
          END,
          n % 29 = 0                                                    -- o'chirilgan
        FROM (
          SELECT n,
            '2026-08-31T19:00:00Z'::timestamptz
              + ((n * 104729) % (30 * 86400)) * interval '1 second'
              -- ms va mikrosekund qismi (CreateDateColumn now() kabi)
              + ((n * 7877) % 1000000) * interval '1 microsecond'
              AS ts
          FROM generate_series(1, 4000) AS n
        ) t
      `);
      // Oynadan tashqari (oldingi va keyingi kun) — hisobga tushmasligi kerak.
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", sold_at, is_deleted)
        VALUES
          (1, 2, 'sold', '2026-08-31T18:59:59.999Z', 1788220000000, false),
          (1, 2, 'sold', '2026-09-30T19:00:00.000Z', 1790800000000, false)
      `);
      const start = '2026-08-31T19:00:00.000Z';
      const end = '2026-09-30T18:59:59.999Z';

      const aggregate = await analytics.getFulfillmentStats(start, end);
      const legacy = legacyFulfillment(await legacyRows(start, end));

      expect(typeof aggregate.deliveredCount).toBe('number');
      expect(typeof aggregate.deliveryMsTotal).toBe('number');
      expect(legacy.deliveryCount).toBeGreaterThan(1500);
      expect(kpiFromAggregate(aggregate)).toEqual(legacy);
    }, 60_000);

    it('⭐ TC7: oyna Toshkent kuni bo`yicha — 01.10 00:30 Toshkent (30.09 19:30Z) 01.10 ga, 30.09 23:30 Toshkent (18:30Z) 30.09 ga', async () => {
      const created1 = Date.parse('2026-09-30T19:30:00.000Z');
      const created2 = Date.parse('2026-09-30T18:30:00.000Z');
      await db.query(
        `INSERT INTO order_schema.orders
           (market_id, customer_id, status, "createdAt", sold_at, is_deleted)
         VALUES (1, 2, 'sold', $1, $2, false), (1, 2, 'sold', $3, $4, false)`,
        [
          new Date(created1).toISOString(),
          String(created1 + 2 * HOUR),
          new Date(created2).toISOString(),
          String(created2 + 30 * HOUR),
        ],
      );

      const october1 = await analytics.getFulfillmentStats(
        '2026-10-01',
        '2026-10-01',
      );
      expect(october1.deliveredCount).toBe(1);
      expect(october1.onTimeCount).toBe(1);
      expect(october1.deliveryMsTotal).toBe(2 * HOUR);

      const september30 = await analytics.getFulfillmentStats(
        '2026-09-30',
        '2026-09-30',
      );
      expect(september30.deliveredCount).toBe(1);
      expect(september30.onTimeCount).toBe(0);
      expect(september30.deliveryMsTotal).toBe(30 * HOUR);
    }, 60_000);

    it('⭐ TC5: 10 000 sotilgan buyurtma — bitta so`rov, 1 s dan ancha tez (10 s timeout emas)', async () => {
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", sold_at, is_deleted)
        SELECT 1, 2, 'sold',
          '2026-07-01T00:00:00Z'::timestamptz + (n % 80) * interval '1 day',
          (EXTRACT(EPOCH FROM '2026-07-01T00:00:00Z'::timestamptz + (n % 80) * interval '1 day') * 1000)::bigint + (n % 50) * 3600000 + 1,
          false
        FROM generate_series(1, 10000) AS n
      `);
      const startedAt = Date.now();
      const aggregate = await analytics.getFulfillmentStats(
        '2026-07-01',
        '2026-09-28',
      );
      const elapsed = Date.now() - startedAt;
      expect(aggregate.deliveredCount).toBe(10000);
      expect(elapsed).toBeLessThan(1000);
    }, 60_000);
  },
);
