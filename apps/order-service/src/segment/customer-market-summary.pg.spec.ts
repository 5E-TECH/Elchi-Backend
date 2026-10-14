import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { CustomerSegmentService } from './customer-segment.service';

/**
 * hiqRNhkI — `order.customer.market_summary` haqiqiy Postgres'da.
 *   ORDER_SUMMARY_PG_TEST_URI=postgres://postgres@127.0.0.1:55465/elchi_e_test
 */
const uri = process.env.ORDER_SUMMARY_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'hiqRNhkI — mijozning marketdagi buyurtma xulosasi (Postgres)',
  () => {
    let db: DataSource;
    let service: CustomerSegmentService;

    const addOrder = async (
      market_id: string,
      customer_id: string,
      status: Order_status,
      opts: { softDeleted?: boolean } = {},
    ): Promise<string> => {
      const repo = db.getRepository(Order);
      const saved = await repo.save(
        repo.create({ market_id, customer_id, status } as Partial<Order>),
      );
      if (opts.softDeleted) {
        await db.query(
          `UPDATE order_schema.orders SET is_deleted = true, deleted_at = now() WHERE id = $1`,
          [saved.id],
        );
      }
      return String(saved.id);
    };

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
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      await db.synchronize();
      service = new CustomerSegmentService(db.getRepository(Order));
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        for (const schema of [
          'order_schema',
          'branch_schema',
          'logistics_schema',
        ]) {
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        await db.destroy();
      }
    });

    it('⭐ TC4: shu marketdagi `created`/`new` buyurtmalar soni va id`lari; boshqa market, o`chirilgan va yopilgan hisobga olinmaydi', async () => {
      const n1 = await addOrder('121', '153', Order_status.NEW);
      const n2 = await addOrder('121', '153', Order_status.CREATED);
      await addOrder('121', '153', Order_status.SOLD);
      await addOrder('121', '153', Order_status.NEW, { softDeleted: true });
      await addOrder('999', '153', Order_status.NEW);
      await addOrder('121', '154', Order_status.SOLD);
      await addOrder('999', '155', Order_status.NEW);

      const res = await service.marketSummary({
        market_id: '121',
        customer_ids: ['153', '154', '155', '156', 'x1'],
      });
      const byId = new Map(
        res.data.items.map((item) => [item.customer_id, item]),
      );

      expect(byId.get('153')).toMatchObject({ orders: 3, new_orders: 2 });
      expect([...byId.get('153')!.new_order_ids].sort()).toEqual(
        [n1, n2].sort(),
      );
      expect(byId.get('154')).toMatchObject({
        orders: 1,
        new_orders: 0,
        new_order_ids: [],
      });
      // ⭐ TC5: shu marketda buyurtmasi yo'q mijoz natijada YO'Q.
      expect(byId.has('155')).toBe(false);
      expect(byId.has('156')).toBe(false);
    });

    it('bo`sh ro`yxat — so`rovsiz bo`sh; market_id noto`g`ri — 400', async () => {
      await expect(
        service.marketSummary({ market_id: '121', customer_ids: [] }),
      ).resolves.toMatchObject({ data: { items: [] } });
      const error: unknown = await service
        .marketSummary({ market_id: '1 OR 1=1', customer_ids: ['1'] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 400,
      });
    });
  },
);
