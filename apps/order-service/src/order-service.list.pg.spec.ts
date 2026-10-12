import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';

const uri = process.env.ORDER_LIST_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_day1_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  "9Rdi2gJF - haqiqiy Postgres ro'yxat sahifalashi",
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    let analytics: OrderAnalyticsService;
    let schemasCreated = false;
    const queries: string[] = [];

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'order_schema',
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: false,
        logging: ['query'],
      });
      jest.spyOn(db.logger, 'logQuery').mockImplementation((sql) => {
        queries.push(sql);
      });
      await db.initialize();
      for (const schema of [
        'order_schema',
        'branch_schema',
        'logistics_schema',
      ]) {
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      schemasCreated = true;
      await db.synchronize();
      await db.query(`
        CREATE TABLE logistics_schema.posts (
          id BIGINT PRIMARY KEY, courier_id BIGINT
        )
      `);
      service = new OrderServiceService(
        db,
        db.getRepository(Order),
        db.getRepository(OrderItem),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      analytics = new OrderAnalyticsService(
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
        {} as never,
        {
          getMarketsByIds: jest
            .fn()
            .mockResolvedValue([{ id: '1', name: 'Market' }]),
          getCouriersByIds: jest.fn().mockResolvedValue([]),
        } as never,
      );
      await db.query(`
        INSERT INTO order_schema.orders (
          market_id, customer_id, status, courier_id,
          holder_courier_id, holder_type, "createdAt"
        )
        SELECT 1, 2, 'cancelled', 77, 77, 'COURIER',
          CASE WHEN n = 1 THEN '2024-01-01T00:00:00Z'::timestamptz ELSE now() END
        FROM generate_series(1, 5001) AS n
      `);
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemasCreated) {
          for (const schema of [
            'order_schema',
            'branch_schema',
            'logistics_schema',
          ]) {
            await db.query(`DROP SCHEMA "${schema}" CASCADE`);
          }
        }
        await db.destroy();
      }
    });

    it('disable_pagination SQL da 5000 limit va truncated=true qaytaradi', async () => {
      queries.length = 0;
      const result = await service.findAll({ disable_pagination: true });
      expect(result.data).toHaveLength(5000);
      expect(result.total).toBe(5001);
      expect(result.truncated).toBe(true);
      expect(queries.some((sql) => /LIMIT 5000\b/i.test(sql))).toBe(true);
    }, 30_000);

    it('kuryer bekor tabining ikki SQL sahifasida id takrorlanmaydi', async () => {
      const query = {
        status: [Order_status.CANCELLED],
        courier_ids: ['77'],
        holder_courier_ids: ['77'],
        courier_scope: 'any' as const,
        courier_post_history: true,
        courier_cancelled_tab: true,
        limit: 10,
      };
      queries.length = 0;
      const first = await service.findAll({ ...query, page: 1 });
      const second = await service.findAll({ ...query, page: 2 });
      expect(first.total).toBe(5001);
      expect(second.total).toBe(5001);
      expect(first.data).toHaveLength(10);
      expect(second.data).toHaveLength(10);
      expect(
        new Set([...first.data, ...second.data].map((row) => row.id)).size,
      ).toBe(20);
      expect(queries.filter((sql) => /LIMIT 10\b/i.test(sql))).toHaveLength(2);
    }, 30_000);

    it("all=true 366 kundan eski buyurtmani ham SQL hisobiga qo'shadi", async () => {
      const end = new Date().toISOString();
      const allOverview = await analytics.getOverviewStats(
        undefined,
        undefined,
        undefined,
        true,
      );
      const allMarkets = await analytics.getMarketStats(
        '1970-01-01',
        end,
        undefined,
        true,
      );
      const cappedMarkets = await analytics.getMarketStats('1970-01-01', end);

      expect(allOverview.acceptedCount).toBe(5001);
      expect(allOverview.applied_range.clamped).toBe(false);
      expect(allMarkets[0].totalOrders).toBe(5001);
      expect(cappedMarkets[0].totalOrders).toBe(5000);
    }, 30_000);
  },
);
