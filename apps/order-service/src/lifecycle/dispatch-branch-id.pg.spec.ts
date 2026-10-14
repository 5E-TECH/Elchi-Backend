/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * hn9zr9A1 — haqiqiy Postgres: dispatch / receivePost `order.update`
 * (`updateFull`) dan keyin `orders.branch_id` manzil filialga o'tadi.
 * `findById` HAQIQIY (relations: items + branch) — aynan jonli #31 dagi
 * holat. Faqat lokal test bazasi (ORDER_DISPATCH_BRANCH_PG_TEST_URI,
 * .../elchi_dispatch_branch_test) berilsa ishlaydi.
 */
const uri = process.env.ORDER_DISPATCH_BRANCH_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_dispatch_branch_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'hn9zr9A1 - dispatch dan keyin orders.branch_id filialga yoziladi (pg)',
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
        // HAQIQIY findById (relations: { items: true, branch: true }).
        orderRepo: db.getRepository(Order),
        lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
        custody: {
          createTrackingEvent: jest.fn(),
          createCustodyEvent: jest.fn(),
          toTrackingRole: jest.fn(() => 'registrator'),
          auditActor: jest.fn(() => ({})),
        },
        syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
        enqueueFinanceOnStatusChange: jest.fn().mockResolvedValue(undefined),
        queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
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
      await db.query('TRUNCATE branch_schema.branches CASCADE');
      await db.query(
        `INSERT INTO branch_schema.branches (id, name)
         VALUES (1, 'HQ'), (15, 'Samarqand filiali')`,
      );
      // HQ'da qabul qilingan (received) buyurtma — #31 kabi.
      await db.query(
        `INSERT INTO order_schema.orders
          (id, market_id, customer_id, status, source, total_price,
           branch_id, home_branch_id, holder_type, post_id)
         VALUES (31, 500, 77, 'received', 'internal', 100000, 1, 1, 'HQ', 48)`,
      );
    });

    const row = async () =>
      (
        await db.query(
          `SELECT branch_id, home_branch_id, holder_type, holder_branch_id,
                  holder_courier_id, status, post_id
           FROM order_schema.orders WHERE id = 31`,
        )
      )[0];

    const requester = { id: '301', roles: ['registrator'], note: 'dispatch' };

    it('⭐ dispatch dto: branch_id=15, holder 15, home HQ', async () => {
      // branch-service dispatchPostToBranch yuboradigan dto.
      await service.updateFull(
        '31',
        {
          branch_id: '15',
          holder_branch_id: '15',
          post_id: '777',
          current_batch_id: null,
          status: Order_status.ON_THE_ROAD,
        } as never,
        requester,
      );

      expect(await row()).toEqual({
        branch_id: '15',
        home_branch_id: '1',
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: '15',
        holder_courier_id: null,
        status: Order_status.ON_THE_ROAD,
        post_id: '777',
      });
    });

    it('⭐ TC1: filial 15 ning branch_id bo`yicha ro`yxatida ko`rinadi', async () => {
      await service.updateFull(
        '31',
        { branch_id: '15', status: Order_status.ON_THE_ROAD },
        requester,
      );

      // `branch_id` bo'yicha filtrlaydigan ro'yxatlar (yangi market/
      // analitika) kabi qat'iy shart.
      const count = await db
        .getRepository(Order)
        .count({ where: { branch_id: '15', isDeleted: false } });
      expect(count).toBe(1);
    });

    it('⭐ receivePost: faqat { branch_id } — filialga o`tadi', async () => {
      await db.query(
        `UPDATE order_schema.orders
         SET status = 'on the road', holder_type = 'BRANCH', holder_branch_id = 15
         WHERE id = 31`,
      );

      await service.updateFull('31', { branch_id: '15' }, requester);

      expect((await row()).branch_id).toBe('15');
    });

    it('regressiya: branch_id yuborilmasa o`zgarmaydi, findById branch relatsiyasini qaytaradi', async () => {
      const updated = await service.updateFull(
        '31',
        { comment: 'izoh' },
        requester,
      );

      expect((await row()).branch_id).toBe('1');
      expect(updated.branch).toEqual(
        expect.objectContaining({ id: '1', name: 'HQ' }),
      );
    });
  },
);
