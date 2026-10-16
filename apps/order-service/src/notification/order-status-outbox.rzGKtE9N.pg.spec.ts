import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Order_status, OutboxEvent, OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderNotificationService } from './order-notification.service';

/**
 * rzGKtE9N TC1 — `order.sell` → outbox'ga holat bildirishnomasi AYNI
 * tranzaksiyada; rollback'da yozuv HAM qaytadi. HAQIQIY Postgres (faqat
 * lokal test bazasi): `outbox_events` + OrderNotificationService.
 * (Mock'li variant — order-notification.service.spec.ts OA16fdSq TC3/TC4.)
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest order-status-outbox.rzGKtE9N
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_order_outbox_test';

(localTestDatabase ? describe : describe.skip)(
  'order holati → outbox (rzGKtE9N TC1, lokal Postgres)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let notifier: OrderNotificationService;
    const order = {
      id: '81',
      market_id: '5',
      operator_id: '9',
      status: Order_status.SOLD,
      total_price: 150_000,
      address: 'Andijon',
      comment: null,
      return_reason: null,
      region_id: null,
      district_id: null,
    };
    const orderRepo = { findOne: jest.fn().mockResolvedValue(order) };

    /** Order jadvali bu test bazasida yo'q — faqat uning o'qilishi soxta. */
    const withOrders = (manager: EntityManager) =>
      new Proxy(manager, {
        get(target, prop, receiver) {
          if (prop === 'getRepository') {
            return (entity: unknown) =>
              entity === Order
                ? orderRepo
                : target.getRepository(entity as never);
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });

    const outboxRows = async () =>
      await db.query(
        `SELECT pattern, target, payload FROM order_schema.outbox_events ORDER BY id`,
      );

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'order_schema',
        entities: [OutboxEvent],
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
      await db.query('CREATE SCHEMA order_schema');
      await db.synchronize();
      notifier = new OrderNotificationService(
        new OutboxService(db.getRepository(OutboxEvent)),
        orderRepo as never,
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    it('⭐ sotuv commit — outbox_events da notification.dispatch (order.sold) AYNI tranzaksiyada', async () => {
      await db.transaction(async (manager) => {
        await notifier.onStatusChange(
          {
            order_id: '81',
            from_status: Order_status.WAITING,
            to_status: Order_status.SOLD,
          },
          withOrders(manager),
        );
        // Commit'dan OLDIN tashqaridan ko'rinmaydi.
        expect(await outboxRows()).toHaveLength(0);
      });
      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          target: 'NOTIFICATION',
          pattern: 'notification.dispatch',
          payload: expect.objectContaining({ type: 'order.sold' }),
        }),
      );
    });

    it('⭐ sotuv tranzaksiyasi rollback — outbox yozuvi HAM yo‘q', async () => {
      const before = (await outboxRows()).length;
      await expect(
        db.transaction(async (manager) => {
          await notifier.onStatusChange(
            {
              order_id: '81',
              from_status: Order_status.WAITING,
              to_status: Order_status.SOLD,
            },
            withOrders(manager),
          );
          throw new Error('kassa yozuvi yiqildi');
        }),
      ).rejects.toThrow('kassa yozuvi yiqildi');
      expect(await outboxRows()).toHaveLength(before);
    });
  },
);
