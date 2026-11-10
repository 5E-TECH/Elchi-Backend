import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';

/**
 * «Marketga topshirildi» tabi (ega 2026-11-10, «Yopildi» o'rniga) — HAQIQIY
 * Postgres'da: `statusCounts.returned_to_market` (gateway `cancel_stage=market`
 * so'rovi) ro'yxat (GET /orders?cancel_stage=market) `total`i bilan bir xil.
 * Sanaladi: returned_to_market (ombor buyurtmasi omborga qaytgani — yo'q),
 * F4 dan oldingi market qo'lidagi closed / bekor. Xom
 * `by_status.returned_to_market` dan farqi shu.
 *
 * Ishga tushirish: ORDER_STATUS_COUNTS_MARKET_PG_TEST_URI=postgres://...@127.0.0.1:PORT/<nom>_test
 * (faqat lokal *_test baza).
 */
const uri = process.env.ORDER_STATUS_COUNTS_MARKET_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

const SCHEMAS = ['order_schema', 'branch_schema', 'logistics_schema'];

(localTestDatabase ? describe : describe.skip)(
  '«Marketga topshirildi» tabi soni (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    let schemasCreated = false;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'order_schema',
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: false,
      });
      await db.initialize();
      for (const schema of SCHEMAS) {
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      schemasCreated = true;
      await db.synchronize();

      const seed: Array<
        [Order_status, string, 'HQ' | 'WAREHOUSE', boolean, string, number]
      > = [
        // [status, holder_type, fulfillment_source, market_handover_at bor, market_id, soni]
        [Order_status.RETURNED_TO_MARKET, 'MARKET', 'HQ', true, '1', 3], // ✔
        [Order_status.RETURNED_TO_MARKET, 'HQ', 'WAREHOUSE', false, '1', 2], // ✘ omborga qaytgan
        [Order_status.RETURNED_TO_MARKET, 'MARKET', 'WAREHOUSE', true, '1', 1], // ✔ ombor, lekin marketga topshirilgan
        [Order_status.CLOSED, 'MARKET', 'HQ', false, '1', 2], // ✔ F4 dan oldingi topshirish
        [Order_status.CLOSED, 'HQ', 'HQ', false, '1', 1], // ✘ provayder «qaytarildi»
        [Order_status.CANCELLED, 'MARKET', 'HQ', false, '1', 1], // ✔ market qo'lida
        [Order_status.CANCELLED, 'HQ', 'HQ', false, '1', 2], // ✘ HQ'da
        [Order_status.SOLD, 'COURIER', 'HQ', false, '1', 4], // ✘
        [Order_status.RETURNED_TO_MARKET, 'MARKET', 'HQ', true, '2', 5], // boshqa market
      ];
      for (const [
        status,
        holder,
        source,
        handedOver,
        marketId,
        count,
      ] of seed) {
        await db.query(
          `INSERT INTO order_schema.orders (
             market_id, customer_id, status, holder_type, fulfillment_source,
             market_handover_at
           )
           SELECT $1::bigint, 2, $2, $3::order_schema.orders_holder_type_enum, $4,
             CASE WHEN $5::boolean THEN now() ELSE NULL END
           FROM generate_series(1, $6::int)`,
          [marketId, status, holder, source, handedOver, count],
        );
      }

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
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemasCreated) {
          for (const schema of SCHEMAS) {
            await db.query(`DROP SCHEMA "${schema}" CASCADE`);
          }
        }
        await db.destroy();
      }
    });

    it('⭐ son = GET /orders?cancel_stage=market total (market filtri bilan); xom holat sonidan farqli', async () => {
      const counts = await service.statusCounts({
        query: { market_id: '1' },
        returned_to_market_query: { market_id: '1', cancel_stages: ['market'] },
      });
      const list = await service.findAll({
        market_id: '1',
        cancel_stages: ['market'],
        page: 1,
        limit: 10,
      });
      expect(counts.returned_to_market).toBe(7);
      expect(list.total).toBe(7);
      // Xom holat: 3 + 2 (omborga qaytgan) + 1 = 6 — tab soni EMAS.
      expect(counts.by_status[Order_status.RETURNED_TO_MARKET]).toBe(6);
      expect(counts.total).toBe(16);
    });

    it('filtrsiz: hamma marketlar (7 + 5); so`rov berilmasa — null', async () => {
      const all = await service.statusCounts({
        query: {},
        returned_to_market_query: { cancel_stages: ['market'] },
      });
      expect(all.returned_to_market).toBe(12);
      const none = await service.statusCounts({ query: {} });
      expect(none.returned_to_market).toBeNull();
    });
  },
);
