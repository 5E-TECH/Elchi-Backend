import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';

/**
 * 0d11ewk7 — kuryer tablari sonlari HAQIQIY Postgres'da: courierOrderCounts
 * natijasi qo'lda sanalgan kutilgan son bilan VA ro'yxat (gateway tab
 * so'rovlari) `total`i bilan bir xil.
 *
 * Ishga tushirish: ORDER_COURIER_COUNTS_PG_TEST_URI=postgres://...@127.0.0.1:PORT/<nom>_test
 * (faqat lokal *_test baza).
 */
const uri = process.env.ORDER_COURIER_COUNTS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

const COURIER_ID = '119';
const SCHEMAS = ['order_schema', 'branch_schema', 'logistics_schema'];

(localTestDatabase ? describe : describe.skip)(
  '0d11ewk7 — kuryer tablari sonlari (haqiqiy Postgres)',
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
      await db.query(`
        CREATE TABLE logistics_schema.posts (
          id BIGINT PRIMARY KEY, courier_id BIGINT
        )
      `);
      // 5, 6 — kuryer 119 ning pochtalari; 9 — boshqa kuryerniki.
      await db.query(
        `INSERT INTO logistics_schema.posts (id, courier_id) VALUES (5, 119), (6, 119), (9, 300)`,
      );

      const seed: Array<[Order_status, string | null, string | null, number]> =
        [
          // [status, post_id, courier_id, soni]
          [Order_status.WAITING, '5', COURIER_ID, 3],
          [Order_status.WAITING, '6', COURIER_ID, 1],
          [Order_status.SOLD, '5', COURIER_ID, 2],
          [Order_status.PAID, '6', COURIER_ID, 1],
          [Order_status.ON_THE_ROAD, '5', COURIER_ID, 1], // «Hammasi»dan tashqari
          [Order_status.RECEIVED, '5', null, 1], // «Hammasi»dan tashqari
          [Order_status.CANCELLED, '5', COURIER_ID, 1], // bekor + hammasi
          [Order_status.CANCELLED, null, COURIER_ID, 2], // faqat bekor
          [Order_status.WAITING, '9', '300', 5], // begona kuryer
          [Order_status.CANCELLED, null, '300', 1], // begona kuryer
        ];
      for (const [status, postId, courierId, count] of seed) {
        await db.query(
          `INSERT INTO order_schema.orders (
             market_id, customer_id, status, post_id, courier_id,
             holder_courier_id, holder_type
           )
           SELECT 1, 2, $1, $2::bigint, $3::bigint, $3::bigint,
             $5::order_schema.orders_holder_type_enum
           FROM generate_series(1, $4::int)`,
          [status, postId, courierId, count, courierId ? 'COURIER' : 'HQ'],
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

    it("uchala tab ham to'g'ri son: waiting 4, all 8, cancelled 3", async () => {
      const counts = await service.courierOrderCounts({
        courier_id: COURIER_ID,
        post_ids: ['5', '6'],
      });
      expect(counts).toEqual({ waiting: 4, all: 8, cancelled: 3 });
    });

    it("son ro'yxat total'i bilan bir xil (gateway tab so'rovlari, limit 10)", async () => {
      const counts = await service.courierOrderCounts({
        courier_id: COURIER_ID,
        post_ids: ['5', '6'],
      });
      const waitingList = await service.findAll({
        post_ids: ['5', '6'],
        status: [Order_status.WAITING],
        page: 1,
        limit: 10,
      });
      const allList = await service.findAll({
        post_ids: ['5', '6'],
        exclude_statuses: [
          Order_status.CREATED,
          Order_status.NEW,
          Order_status.RECEIVED,
          Order_status.ON_THE_ROAD,
        ],
        page: 1,
        limit: 10,
      });
      const cancelledList = await service.findAll({
        status: [Order_status.CANCELLED],
        courier_ids: [COURIER_ID],
        holder_courier_ids: [COURIER_ID],
        courier_scope: 'any',
        courier_post_history: true,
        courier_cancelled_tab: true,
        page: 1,
        limit: 10,
      });
      expect(counts.waiting).toBe(waitingList.total);
      expect(counts.all).toBe(allList.total);
      expect(counts.cancelled).toBe(cancelledList.total);
      expect(allList.data).toHaveLength(8);
    });

    it("buyurtma sotilgach «Kutilayotgan» darhol kamayadi (kesh yo'q, har so'rov SQL)", async () => {
      await db.query(
        `UPDATE order_schema.orders SET status = 'sold'
         WHERE id = (SELECT id FROM order_schema.orders
                     WHERE status = 'waiting' AND post_id = 5 LIMIT 1)`,
      );
      const counts = await service.courierOrderCounts({
        courier_id: COURIER_ID,
        post_ids: ['5', '6'],
      });
      expect(counts).toEqual({ waiting: 3, all: 8, cancelled: 3 });
    });
  },
);
