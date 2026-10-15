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
 * (W20LoskP) "Buyurtmalar hisoboti" SQL agregatlari — HAQIQIY Postgres'da.
 *
 * Ilgari analytics-service `order.find_all` ni 100 sahifagacha tortib
 * (≤ 10 000 qator) viloyat/mahsulotni JS'da sanardi va 9 ta qo'lda yozilgan
 * status bo'yicha 9 ta count qilardi. Bu spec yangi GROUP BY natijalarini
 * (a) ro'yxat (`GET /orders`) qoidasidagi to'g'ridan-to'g'ri hisob bilan,
 * (b) `overview.acceptedCount` bilan, (c) eski JS hisobining kesilmagan
 * nusxasi bilan solishtiradi.
 *
 * Faqat lokal test bazasida ishlaydi (prod/umumiy baza emas):
 *   ORDER_REPORT_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_h_report
 */
const uri = process.env.ORDER_REPORT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_h_report'
  );
})();

// 01.01.2026 – 18.09.2026 (Toshkent) oynasi.
const START = '2026-01-01';
const END = '2026-09-18';
const START_ISO = '2025-12-31T19:00:00.000Z';
const END_ISO = '2026-09-18T18:59:59.999Z';

(localTestDatabase ? describe : describe.skip)(
  'W20LoskP — buyurtmalar hisoboti SQL agregatlari (haqiqiy Postgres)',
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

    /** `GET /orders?status=...&start_day=&end_day=` qoidasi (findAll). */
    async function listCount(status: string) {
      const [row] = await db.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM order_schema.orders
          WHERE is_deleted = false AND deleted_at IS NULL AND status = $1
            AND "createdAt" >= $2 AND "createdAt" <= $3`,
        [status, START_ISO, END_ISO],
      );
      return Number(row.count);
    }

    it('⭐ TC1/TC2/TC3: har bir status (waiting = 18) ro`yxat bilan teng, yig`indi = acceptedCount', async () => {
      const statuses = Object.values(Order_status);
      // Har status uchun turlicha son; 'waiting' — aynan 18 ta.
      const plan = statuses.map((status, i) => ({
        status,
        count: status === Order_status.WAITING ? 18 : (i * 7) % 11,
      }));
      for (const { status, count } of plan) {
        if (count === 0) continue;
        await db.query(
          `INSERT INTO order_schema.orders
             (market_id, customer_id, status, "createdAt", is_deleted)
           SELECT 1, 2, $1::order_schema.orders_status_enum,
             '2026-03-01T10:00:00Z'::timestamptz + n * interval '1 hour', false
           FROM generate_series(1, $2::int) AS n`,
          [status, count],
        );
      }
      // Hisobga TUSHMASLIGI kerak: o'chirilgan, soft-delete, oynadan tashqari.
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", is_deleted, deleted_at)
        VALUES
          (1, 2, 'waiting', '2026-03-02T10:00:00Z', true, NULL),
          (1, 2, 'waiting', '2026-03-02T10:00:00Z', true, '2026-03-03T00:00:00Z'),
          (1, 2, 'waiting', '2025-12-31T18:59:59.999Z', false, NULL),
          (1, 2, 'waiting', '2026-09-18T19:00:00.000Z', false, NULL)
      `);

      const res = await analytics.getOrderStatusDistribution(START, END);

      // TC3: enumdagi HAR BIR kalit bor (0 bo'lsa ham).
      expect(Object.keys(res.distribution).sort()).toEqual(
        [...statuses].sort(),
      );
      // TC1: 'waiting' = 18 va har bir status ro'yxat soni bilan AYNAN teng.
      expect(res.distribution[Order_status.WAITING]).toBe(18);
      for (const { status, count } of plan) {
        expect({ status, n: res.distribution[status] }).toEqual({
          status,
          n: count,
        });
        expect(await listCount(status)).toBe(count);
      }
      // TC2: yig'indi = overview.acceptedCount.
      const overview = await analytics.getOverviewStats(START, END);
      const sum = Object.values(res.distribution).reduce((a, b) => a + b, 0);
      expect(sum).toBe(overview.acceptedCount);
      expect(res.total).toBe(overview.acceptedCount);
      expect(res.applied_range.clamped).toBe(false);
    }, 60_000);

    it('⭐ TC4/TC5: 12 345 buyurtma — byRegion va topProducts KESILMAYDI, eski JS hisobining to`liq nusxasi bilan teng, < 1 s', async () => {
      const N = 12_345;
      await db.query(
        `INSERT INTO order_schema.orders
           (market_id, customer_id, status, "createdAt", region_id, is_deleted)
         SELECT 1, 2,
           (ARRAY['new','waiting','sold','cancelled','created'])[1 + (n % 5)]::order_schema.orders_status_enum,
           '2026-01-01T00:00:00Z'::timestamptz + ((n * 7919) % (250 * 86400)) * interval '1 second',
           CASE WHEN n % 10 = 0 THEN NULL ELSE (n % 14) + 1 END,
           false
         FROM generate_series(1, $1::int) AS n`,
        [N],
      );
      // Har buyurtmaga 1–2 qator; ba'zilari katalogsiz (product_id NULL).
      await db.query(`
        INSERT INTO order_schema.order_items (order_id, product_id, quantity)
        SELECT o.id,
          CASE WHEN o.id % 41 = 0 THEN NULL ELSE (o.id % 37) + 1 END,
          1 + (o.id % 5)::int
        FROM order_schema.orders o
        UNION ALL
        SELECT o.id, (o.id % 13) + 100, 2
        FROM order_schema.orders o WHERE o.id % 3 = 0
      `);

      const startedAt = Date.now();
      const [byRegion, topProducts] = await Promise.all([
        analytics.getOrdersByRegion(START, END),
        analytics.getTopOrderedProducts(START, END, undefined, 10),
      ]);
      const elapsed = Date.now() - startedAt;

      // Eski JS hisobi — LEKIN 10 000 da kesilmagan: oynadagi barcha qatorlar.
      const orders = await db.query<
        Array<{ id: string; region_id: string | null }>
      >(
        `SELECT id, region_id FROM order_schema.orders
          WHERE is_deleted = false AND "createdAt" >= $1 AND "createdAt" <= $2`,
        [START_ISO, END_ISO],
      );
      const items = await db.query<
        Array<{ product_id: string | null; quantity: number }>
      >(
        `SELECT i.product_id, i.quantity FROM order_schema.order_items i
           JOIN order_schema.orders o ON o.id = i.order_id
          WHERE o.is_deleted = false AND o."createdAt" >= $1 AND o."createdAt" <= $2`,
        [START_ISO, END_ISO],
      );
      expect(orders.length).toBeGreaterThan(10_000);

      const regionMap = new Map<string, number>();
      for (const o of orders) {
        const key = String(o.region_id ?? 'unknown');
        regionMap.set(key, (regionMap.get(key) ?? 0) + 1);
      }
      const productMap = new Map<string, number>();
      for (const it of items) {
        const key = String(it.product_id ?? 'unknown');
        productMap.set(key, (productMap.get(key) ?? 0) + Number(it.quantity));
      }

      // TC4: viloyatlar to'liq — yig'indi = oynadagi barcha buyurtmalar.
      expect(byRegion.total).toBe(orders.length);
      expect(byRegion.items).toHaveLength(regionMap.size);
      for (const row of byRegion.items) {
        expect(row.total_orders).toBe(regionMap.get(row.region_id));
      }
      expect(byRegion.items.map((r) => r.region_id)).toContain('unknown');
      // Kamayish tartibida.
      for (let i = 1; i < byRegion.items.length; i += 1) {
        expect(byRegion.items[i - 1].total_orders).toBeGreaterThanOrEqual(
          byRegion.items[i].total_orders,
        );
      }

      // Top mahsulotlar: 10 ta, har biri JS jami bilan teng, eng kattalari.
      const expectedTop = [...productMap.values()]
        .sort((a, b) => b - a)
        .slice(0, 10);
      expect(topProducts.items).toHaveLength(10);
      expect(topProducts.items.map((p) => p.total_quantity)).toEqual(
        expectedTop,
      );
      for (const row of topProducts.items) {
        expect(row.total_quantity).toBe(productMap.get(row.product_id));
      }

      // TC5: bitta SQL — 12 s gateway timeout'idan ancha tez.
      expect(elapsed).toBeLessThan(1000);
    }, 120_000);

    it('filial doirasi: boshqa filial buyurtmalari tushmaydi', async () => {
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", region_id, branch_id, is_deleted)
        VALUES
          (1, 2, 'waiting', '2026-03-01T10:00:00Z', 5, 11, false),
          (1, 2, 'waiting', '2026-03-01T10:00:00Z', 5, 11, false),
          (1, 2, 'new',     '2026-03-01T10:00:00Z', 6, 22, false)
      `);
      const scoped = await analytics.getOrderStatusDistribution(
        START,
        END,
        '11',
      );
      expect(scoped.total).toBe(2);
      expect(scoped.distribution[Order_status.WAITING]).toBe(2);
      expect(scoped.distribution[Order_status.NEW]).toBe(0);
      const regions = await analytics.getOrdersByRegion(START, END, '11');
      expect(regions.items).toEqual([{ region_id: '5', total_orders: 2 }]);
    }, 60_000);

    it('⭐ Celz3rKJ TC6: source_distribution — internal/external/branch/bot, yig`indi = acceptedCount', async () => {
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", source, external_id, created_via, is_deleted)
        VALUES
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', NULL,  NULL,  false),
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', NULL,  NULL,  false),
          (1, 2, 'sold', '2026-03-01T10:00:00Z', 'internal', NULL,  NULL,  false),
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'external', 'P-1', NULL,  false),
          -- eski qator: source internal, lekin external_id bor → tashqi
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', 'P-2', NULL,  false),
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'branch',   NULL,  NULL,  false),
          -- Telegram bot (created_via = 'bot') — alohida 'bot' bucket
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', NULL,  'bot', false),
          (1, 2, 'sold', '2026-03-01T10:00:00Z', 'internal', NULL,  'bot', false),
          -- hisobga tushmaydi: o'chirilgan va davrdan tashqari
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', NULL,  'bot', true),
          (1, 2, 'new',  '2026-03-01T10:00:00Z', 'internal', NULL,  NULL,  true),
          (1, 2, 'new',  '2026-09-18T19:00:00Z', 'internal', NULL,  NULL,  false)
      `);
      const res = await analytics.getOrderSourceDistribution(START, END);
      expect(res).toMatchObject({
        internal: 3,
        external: 2,
        branch: 1,
        bot: 2,
        total: 8,
      });
      const overview = await analytics.getOverviewStats(START, END);
      expect(res.total).toBe(overview.acceptedCount);
    }, 60_000);

    it('limit 1..50 bilan cheklanadi, noto`g`ri qiymat → 10', async () => {
      await db.query(`
        INSERT INTO order_schema.orders
          (market_id, customer_id, status, "createdAt", is_deleted)
        SELECT 1, 2, 'new', '2026-03-01T10:00:00Z', false
        FROM generate_series(1, 60)
      `);
      await db.query(`
        INSERT INTO order_schema.order_items (order_id, product_id, quantity)
        SELECT id, id, 1 FROM order_schema.orders
      `);
      expect(
        (await analytics.getTopOrderedProducts(START, END, undefined, 500))
          .items,
      ).toHaveLength(50);
      expect(
        (
          await analytics.getTopOrderedProducts(
            START,
            END,
            undefined,
            'abc' as never,
          )
        ).items,
      ).toHaveLength(10);
    }, 60_000);
  },
);
