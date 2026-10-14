/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { DataSource } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * (52NJNGaH TC3) Haqiqiy Postgres: `updateFull` dan keyin `order_items`
 * jadvalida `product_name` saqlanadi; noto'g'ri ro'yxat eski satrlarga
 * tegmaydi. Faqat lokal test bazasi (ORDER_ITEMS_PG_TEST_URI,
 * .../elchi_order_items_test) berilsa ishlaydi.
 */
const uri = process.env.ORDER_ITEMS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_order_items_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  '52NJNGaH - order_items jadvalida product_name saqlanadi',
  () => {
    let db: DataSource;
    let service: OrderLifecycleService;

    beforeAll(async () => {
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
      await db.synchronize();
      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Record<string, any>;
      Object.assign(instance, {
        dataSource: db,
        findById: (id: string) =>
          db
            .getRepository(Order)
            .findOneOrFail({ where: { id }, relations: { items: true } }),
        transferBatchItemRepo: { find: jest.fn().mockResolvedValue([]) },
        custody: {
          createTrackingEvent: jest.fn(),
          createCustodyEvent: jest.fn(),
          toTrackingRole: jest.fn(() => 'superadmin'),
          auditActor: jest.fn(() => ({})),
        },
        syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
      });
      service = instance;
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "order_schema" CASCADE');
        await db.query('DROP SCHEMA IF EXISTS "branch_schema" CASCADE');
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await db.query('TRUNCATE order_schema.orders CASCADE');
      await db.query(
        `INSERT INTO order_schema.orders
          (id, market_id, customer_id, status, source, total_price, product_quantity)
         VALUES (1251134, 500, 77, 'new', 'external', 300000, 4)`,
      );
      await db.query(
        `INSERT INTO order_schema.order_items (order_id, product_id, product_name, quantity)
         VALUES (1251134, NULL, 'Kitob', 1), (1251134, NULL, 'Daftar', 3)`,
      );
    });

    const items = () =>
      db.query(
        `SELECT product_id, product_name, quantity
         FROM order_schema.order_items WHERE order_id = 1251134
         ORDER BY product_name`,
      );

    const requester = { id: '1', roles: ['superadmin'] };

    it('soni o`zgartirilganda nomlar saqlanadi, olib tashlangani yo`qoladi', async () => {
      await service.updateFull(
        '1251134',
        { items: [{ product_id: null, product_name: 'Daftar', quantity: 2 }] },
        requester,
      );

      expect(await items()).toEqual([
        { product_id: null, product_name: 'Daftar', quantity: 2 },
      ]);
      const [order] = await db.query(
        'SELECT product_quantity FROM order_schema.orders WHERE id = 1251134',
      );
      expect(order.product_quantity).toBe(2);
    });

    it('nomsiz va product_id siz satr — 400, eski satrlar joyida', async () => {
      await expect(
        service.updateFull(
          '1251134',
          { items: [{ product_id: null, quantity: 1 }] },
          requester,
        ),
      ).rejects.toBeDefined();

      expect(await items()).toEqual([
        { product_id: null, product_name: 'Daftar', quantity: 3 },
        { product_id: null, product_name: 'Kitob', quantity: 1 },
      ]);
    });
  },
);
