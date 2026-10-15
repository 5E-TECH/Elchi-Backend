import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

const uri = process.env.POST_ORDER_DELETE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_day1_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'yokjwjXG - haqiqiy Postgres pochta/buyurtma tranzaksiyasi',
  () => {
    let db: DataSource;
    let service: OrderLifecycleService;
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
          id BIGINT PRIMARY KEY,
          status TEXT NOT NULL,
          is_deleted BOOLEAN NOT NULL DEFAULT false,
          order_quantity INTEGER NOT NULL,
          post_total_price NUMERIC(14,2) NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Record<string, any>;
      Object.assign(instance, {
        findById: (id: string) =>
          db.getRepository(Order).findOneByOrFail({ id, isDeleted: false }),
        dataSource: db,
        removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        custody: { auditActor: jest.fn(() => ({})) },
      });
      service = instance;
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

    beforeEach(async () => {
      await db.query('TRUNCATE order_schema.orders CASCADE');
      await db.query('TRUNCATE logistics_schema.posts');
    });

    async function seed(status = 'new', paidOnline = 0) {
      await db.query(
        `INSERT INTO logistics_schema.posts
          (id, status, order_quantity, post_total_price)
         VALUES (88, $1, 2, 300000)`,
        [status],
      );
      await db.query(
        `INSERT INTO order_schema.orders
          (id, market_id, customer_id, status, post_id, total_price,
           paid_online_amount, holder_type)
         VALUES (700, 10, 20, 'received', 88, 100000, $1, 'HQ'),
                (701, 10, 20, 'received', 88, 200000, 0, 'HQ')`,
        [paidOnline],
      );
    }

    const requester = { id: '1', roles: ['superadmin'] };

    it("o'chirilgan qatorni sanamaydi, qolgan summa aniq saqlanadi", async () => {
      await seed();
      await service.remove('700', requester);

      const [post]: Array<{
        order_quantity: number;
        post_total_price: string;
      }> = await db.query(
        'SELECT order_quantity, post_total_price FROM logistics_schema.posts WHERE id = 88',
      );
      const orders: Array<{ id: string; is_deleted: boolean }> = await db.query(
        'SELECT id, is_deleted FROM order_schema.orders ORDER BY id',
      );
      expect(post.order_quantity).toBe(1);
      expect(Number(post.post_total_price)).toBe(200_000);
      expect(orders).toEqual([
        { id: '700', is_deleted: true },
        { id: '701', is_deleted: false },
      ]);
    });

    it("jo'natilgan pochtaga tegmaydi", async () => {
      await seed('sent');
      await expect(service.remove('700', requester)).rejects.toBeInstanceOf(
        RpcException,
      );
      const [order]: Array<{ is_deleted: boolean }> = await db.query(
        'SELECT is_deleted FROM order_schema.orders WHERE id = 700',
      );
      expect(order.is_deleted).toBe(false);
    });

    it("onlayn to'langan buyurtmani qaytarishsiz o'chirmaydi", async () => {
      await seed('new', 25_000);
      await expect(service.remove('700', requester)).rejects.toBeInstanceOf(
        RpcException,
      );
      const [order]: Array<{ is_deleted: boolean }> = await db.query(
        'SELECT is_deleted FROM order_schema.orders WHERE id = 700',
      );
      expect(order.is_deleted).toBe(false);
    });

    it("⭐ eskirgan o'qish: UPDATE 0 qatorga tegsa 409 (TypeORM [rows, rowCount] — ilgari .length doim 2 edi)", async () => {
      await seed();
      // findById tranzaksiyadan TASHQARIDA o'qiydi — o'rtada buyurtmaga
      // qaytarish so'raldi. Eskirgan obyekt oldindan tekshiruvdan o'tadi,
      // UPDATE esa shartga mos qatorni topmaydi.
      const stale = await db
        .getRepository(Order)
        .findOneByOrFail({ id: '700', isDeleted: false });
      await db.query(
        'UPDATE order_schema.orders SET return_requested = true WHERE id = 700',
      );
      const instance = service as OrderLifecycleService & {
        findById: (id: string) => Promise<Order>;
      };
      const findById = jest
        .spyOn(instance, 'findById')
        .mockResolvedValue(stale);
      try {
        const error = await service
          .remove('700', requester)
          .catch((err: unknown) => err);
        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toMatchObject({
          statusCode: 409,
        });
      } finally {
        findById.mockRestore();
      }
      const [post]: Array<{ order_quantity: number }> = await db.query(
        'SELECT order_quantity FROM logistics_schema.posts WHERE id = 88',
      );
      expect(post.order_quantity).toBe(2);
    });

    it("pochta UPDATE yiqilsa order ham rollback bo'ladi", async () => {
      await seed();
      await db.query(`
        CREATE FUNCTION logistics_schema.reject_post_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'post update blocked';
        END $$
      `);
      await db.query(`
        CREATE TRIGGER reject_post_update BEFORE UPDATE ON logistics_schema.posts
        FOR EACH ROW EXECUTE FUNCTION logistics_schema.reject_post_update()
      `);
      try {
        await expect(service.remove('700', requester)).rejects.toThrow(
          'post update blocked',
        );
      } finally {
        await db.query(
          'DROP TRIGGER reject_post_update ON logistics_schema.posts',
        );
        await db.query('DROP FUNCTION logistics_schema.reject_post_update()');
      }
      const [order]: Array<{ is_deleted: boolean }> = await db.query(
        'SELECT is_deleted FROM order_schema.orders WHERE id = 700',
      );
      expect(order.is_deleted).toBe(false);
    });
  },
);
