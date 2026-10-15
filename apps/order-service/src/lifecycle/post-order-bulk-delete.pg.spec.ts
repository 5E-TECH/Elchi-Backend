import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * yokjwjXG — `order.post.delete_orders` HAQIQIY Postgres'da: qulf (FOR
 * UPDATE), hammasi-yoki-hech biri rollback, pochta sanog'ini jonli
 * qatorlardan qayta hisoblash, bo'sh pochtani o'chirish, partiya va outbox
 * (tranzaksiya ichida). Haqiqiy OutboxService va OrderCustodyService.
 *
 * Ishga tushirish (lokal PG, prod EMAS):
 *   POST_ORDER_BULK_DELETE_PG_TEST_URI=postgres://postgres@127.0.0.1:55471/elchi_yok_bulk_test
 */
const uri = process.env.POST_ORDER_BULK_DELETE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_yok_bulk_test'
  );
})();

const SCHEMAS = ['order_schema', 'branch_schema', 'logistics_schema'];

(localTestDatabase ? describe : describe.skip)(
  'yokjwjXG — haqiqiy Postgres: pochtadan ko`p buyurtmani o`chirish',
  () => {
    let db: DataSource;
    let service: OrderLifecycleService;
    let activityLog: { log: jest.Mock };
    let schemasCreated = false;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'order_schema',
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          BranchTransferBatch,
          BranchTransferBatchItem,
          BranchTransferBatchHistory,
          OutboxEvent,
        ],
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
          id BIGINT PRIMARY KEY,
          status TEXT NOT NULL,
          is_deleted BOOLEAN NOT NULL DEFAULT false,
          qr_code_token TEXT,
          region_id BIGINT,
          courier_id BIGINT NOT NULL DEFAULT 0,
          branch_id BIGINT,
          order_quantity INTEGER NOT NULL,
          post_total_price NUMERIC(14,2) NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      activityLog = { log: jest.fn().mockResolvedValue(undefined) };
      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Record<string, any>;
      Object.assign(instance, {
        dataSource: db,
        outbox: new OutboxService(db.getRepository(OutboxEvent)),
        activityLog,
        custody: new OrderCustodyService(
          db.getRepository(OrderTracking),
          db.getRepository(OrderCustodyEvent),
        ),
      });
      service = instance;
    }, 60_000);

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

    beforeEach(async () => {
      activityLog.log.mockClear();
      await db.query(
        `TRUNCATE order_schema.orders, order_schema.order_tracking,
                  order_schema.branch_transfer_batches,
                  order_schema.branch_transfer_batch_items,
                  order_schema.branch_transfer_batch_history,
                  order_schema.outbox_events CASCADE`,
      );
      await db.query('TRUNCATE logistics_schema.posts');
    });

    const requester = { id: '1', roles: ['superadmin'] };
    const reason = 'Market posilkani qaytarib oldi';

    async function seed(
      orders: Array<{
        id: number;
        price: number;
        holder?: string;
        external_id?: string | null;
        batch?: number | null;
        paid_online?: number;
      }>,
      postStatus = 'new',
    ) {
      const total = orders.reduce((sum, o) => sum + o.price, 0);
      await db.query(
        `INSERT INTO logistics_schema.posts
          (id, status, qr_code_token, region_id, order_quantity, post_total_price)
         VALUES (88, $1, 'POST-qr', 5, $2, $3)`,
        [postStatus, orders.length, total],
      );
      for (const o of orders) {
        await db.query(
          `INSERT INTO order_schema.orders
            (id, market_id, customer_id, status, post_id, total_price,
             holder_type, external_id, source, current_batch_id,
             paid_online_amount)
           VALUES ($1, 10, 20, 'received', 88, $2, $3, $4, $5, $6, $7)`,
          [
            o.id,
            o.price,
            o.holder ?? 'HQ',
            o.external_id ?? null,
            o.external_id ? 'external' : 'internal',
            o.batch ?? null,
            o.paid_online ?? 0,
          ],
        );
      }
    }

    const orderRows = async () =>
      await db.query(
        `SELECT id, is_deleted, deleted_at IS NOT NULL AS has_deleted_at,
                current_batch_id
         FROM order_schema.orders ORDER BY id`,
      );
    const postRow = async () =>
      (
        await db.query(
          'SELECT order_quantity, post_total_price FROM logistics_schema.posts WHERE id = 88',
        )
      )[0];
    const outbox = async () =>
      await db.query(
        'SELECT target, pattern, payload FROM order_schema.outbox_events ORDER BY id',
      );

    it('⭐ ikki buyurtma o`chadi; pochta sanog`i/summasi (numeric, tiyin aniqligi) jonli qatordan; tracking va outbox shu tranzaksiyada', async () => {
      await seed([
        { id: 700, price: 100_000.25 },
        { id: 701, price: 200_000.5 },
        { id: 702, price: 50_000.75 },
      ]);

      const res: any = await service.deleteOrdersFromPost({
        post_id: '88',
        order_ids: ['701', '700'],
        reason,
        requester,
      });

      expect(res.data).toMatchObject({
        deleted: ['701', '700'],
        skipped: [],
        post_deleted: false,
        order_quantity: 1,
        post_total_price: 50_000.75,
      });
      expect(await orderRows()).toEqual([
        {
          id: '700',
          is_deleted: true,
          has_deleted_at: true,
          current_batch_id: null,
        },
        {
          id: '701',
          is_deleted: true,
          has_deleted_at: true,
          current_batch_id: null,
        },
        {
          id: '702',
          is_deleted: false,
          has_deleted_at: false,
          current_batch_id: null,
        },
      ]);
      const post = await postRow();
      expect(post.order_quantity).toBe(1);
      expect(post.post_total_price).toBe('50000.75');

      const tracking = await db.query(
        `SELECT order_id, action, from_status, to_status, note
         FROM order_schema.order_tracking ORDER BY order_id`,
      );
      expect(tracking).toEqual([
        {
          order_id: '700',
          action: 'deleted_from_post',
          from_status: 'received',
          to_status: 'received',
          note: reason,
        },
        {
          order_id: '701',
          action: 'deleted_from_post',
          from_status: 'received',
          to_status: 'received',
          note: reason,
        },
      ]);
      const events = await outbox();
      expect(
        events.map((e) => `${e.target}:${e.pattern}:${e.payload.sourceId}`),
      ).toEqual([
        'SEARCH:search.index.remove:701',
        'SEARCH:search.index.remove:700',
        'SEARCH:search.index.upsert:88',
      ]);
    });

    it("⭐ hammasi-yoki-hech biri: bittasi kuryerda → 409, buyurtma/pochta/tracking/outbox o'zgarmaydi", async () => {
      await seed([
        { id: 700, price: 100_000 },
        { id: 701, price: 200_000, holder: 'COURIER' },
      ]);

      await expect(
        service.deleteOrdersFromPost({
          post_id: '88',
          order_ids: ['700', '701'],
          reason,
          requester,
        }),
      ).rejects.toBeInstanceOf(RpcException);

      expect((await orderRows()).map((o) => o.is_deleted)).toEqual([
        false,
        false,
      ]);
      expect((await postRow()).order_quantity).toBe(2);
      expect(
        await db.query('SELECT 1 FROM order_schema.order_tracking'),
      ).toEqual([]);
      expect(await outbox()).toEqual([]);
    });

    it("⭐ oxirgi buyurtmalar o'chsa bo'sh pochta HARD o'chadi, qidiruvdan chiqadi; takror so'rov — 200 skipped", async () => {
      await seed([
        { id: 700, price: 100_000 },
        { id: 701, price: 200_000 },
      ]);
      const body = {
        post_id: '88',
        order_ids: ['700', '701'],
        reason,
        requester,
      };

      const res: any = await service.deleteOrdersFromPost(body);

      expect(res.data).toMatchObject({ post_deleted: true, order_quantity: 0 });
      expect(await db.query('SELECT id FROM logistics_schema.posts')).toEqual(
        [],
      );
      expect(
        (await outbox()).some(
          (e) =>
            e.pattern === 'search.index.remove' &&
            e.payload.type === 'post' &&
            e.payload.sourceId === '88',
        ),
      ).toBe(true);

      const again: any = await service.deleteOrdersFromPost(body);
      expect(again.statusCode).toBe(200);
      expect(again.data).toMatchObject({
        deleted: [],
        skipped: ['700', '701'],
        post_deleted: true,
      });
    });

    it("⭐ qulf: parallel tranzaksiya pochtani ushlab, buyurtmani kuryerga bersa — biz KUTAMIZ va yangi holatni ko'rib 409 qaytaramiz", async () => {
      await seed([
        { id: 700, price: 100_000 },
        { id: 701, price: 200_000 },
      ]);
      const other = db.createQueryRunner();
      await other.connect();
      await other.startTransaction();
      let deletePromise: Promise<unknown> | undefined;
      try {
        await other.query(
          'SELECT id FROM logistics_schema.posts WHERE id = 88 FOR UPDATE',
        );
        await other.query(
          `UPDATE order_schema.orders SET holder_type = 'COURIER' WHERE id = 701`,
        );
        deletePromise = service
          .deleteOrdersFromPost({
            post_id: '88',
            order_ids: ['700', '701'],
            reason,
            requester,
          })
          .then(
            () => 'ok',
            (error: unknown) =>
              error instanceof RpcException
                ? (error.getError() as { statusCode: number }).statusCode
                : error,
          );
        // Bizning so'rov qulfda turibdi — hali tugamagan.
        const early = await Promise.race([
          deletePromise,
          new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
        ]);
        expect(early).toBe('waiting');
        await other.commitTransaction();
      } finally {
        if (other.isTransactionActive) await other.rollbackTransaction();
        await other.release();
      }

      expect(await deletePromise).toBe(409);
      expect((await orderRows()).map((o) => o.is_deleted)).toEqual([
        false,
        false,
      ]);
    });

    it("lock_timeout: pochta 5 s dan ko'p band bo'lsa 409 'band' (osilib qolmaydi)", async () => {
      await seed([{ id: 700, price: 100_000 }]);
      const other = db.createQueryRunner();
      await other.connect();
      await other.startTransaction();
      try {
        await other.query(
          'SELECT id FROM logistics_schema.posts WHERE id = 88 FOR UPDATE',
        );
        const err = await service
          .deleteOrdersFromPost({
            post_id: '88',
            order_ids: ['700'],
            reason,
            requester,
          })
          .catch((error: unknown) => error);
        expect(err).toBeInstanceOf(RpcException);
        expect((err as RpcException).getError()).toMatchObject({
          statusCode: 409,
          message: expect.stringContaining('band'),
        });
      } finally {
        await other.rollbackTransaction();
        await other.release();
      }
    }, 20_000);

    it('⭐ hamkor buyurtmasi + onlayn oldindan to`lov: o`chadi, INTEGRATION detach outbox qatori shu tranzaksiyada', async () => {
      await seed([
        { id: 700, price: 120_000, external_id: 'BP-555', paid_online: 40_000 },
        { id: 701, price: 200_000 },
      ]);

      await service.deleteOrdersFromPost({
        post_id: '88',
        order_ids: ['700'],
        reason,
        requester,
      });

      const detach = (await outbox()).filter((e) => e.target === 'INTEGRATION');
      expect(detach).toHaveLength(1);
      expect(detach[0]).toMatchObject({
        pattern: 'integration.partner.shipment.detach',
        payload: expect.objectContaining({
          order_id: '700',
          external_order_id: 'BP-555',
          new_status: 'cancelled',
        }),
      });
      const log = activityLog.log.mock.calls
        .map((c) => c[0])
        .find((entry) => entry.entity_type === 'Order');
      expect(log.metadata).toMatchObject({ paid_online_amount: 40_000 });
    });

    it('⭐ partiya: PENDING dan chiqariladi (item soft-delete, sanoq qayta), bo`sh qolsa CANCELLED + tarix', async () => {
      await db.query(
        `INSERT INTO order_schema.branch_transfer_batches
          (id, qr_code_token, source_branch_id, request_key,
           destination_branch_id, direction, target_region_id, status,
           order_count, total_price)
         VALUES (5, 'BTB-batch05', 1, 'k5', 2, 'FORWARD', 5, 'PENDING', 1, 100000),
                (6, 'BTB-batch06', 1, 'k6', 2, 'FORWARD', 5, 'PENDING', 2, 300000)`,
      );
      await seed([
        { id: 700, price: 100_000, batch: 5 },
        { id: 701, price: 200_000, batch: 6 },
        { id: 702, price: 300_000 },
      ]);
      await db.query(
        `INSERT INTO order_schema.branch_transfer_batch_items
          (batch_id, order_id, snapshot_price, snapshot_market_id)
         VALUES (5, 700, 100000, 10), (6, 701, 200000, 10), (6, 702, 100000, 10)`,
      );

      await service.deleteOrdersFromPost({
        post_id: '88',
        order_ids: ['700', '701'],
        reason,
        requester,
      });

      const batches = await db.query(
        `SELECT id, status, order_count, total_price, cancelled_at IS NOT NULL AS cancelled
         FROM order_schema.branch_transfer_batches ORDER BY id`,
      );
      expect(batches).toEqual([
        {
          id: '5',
          status: 'CANCELLED',
          order_count: 0,
          total_price: 0,
          cancelled: true,
        },
        {
          id: '6',
          status: 'PENDING',
          order_count: 1,
          total_price: 100000,
          cancelled: false,
        },
      ]);
      const items = await db.query(
        `SELECT batch_id, order_id, is_deleted
         FROM order_schema.branch_transfer_batch_items ORDER BY order_id`,
      );
      expect(items).toEqual([
        { batch_id: '5', order_id: '700', is_deleted: true },
        { batch_id: '6', order_id: '701', is_deleted: true },
        { batch_id: '6', order_id: '702', is_deleted: false },
      ]);
      const history = await db.query(
        'SELECT batch_id, action, user_id FROM order_schema.branch_transfer_batch_history',
      );
      expect(history).toEqual([
        { batch_id: '5', action: 'CANCELLED', user_id: '1' },
      ]);
      expect((await orderRows()).map((o) => o.current_batch_id)).toEqual([
        null,
        null,
        null,
      ]);
    });

    it("SENT partiyadagi buyurtma → 409, partiya ham, buyurtma ham o'zgarmaydi", async () => {
      await db.query(
        `INSERT INTO order_schema.branch_transfer_batches
          (id, qr_code_token, source_branch_id, request_key,
           destination_branch_id, direction, target_region_id, status,
           order_count, total_price)
         VALUES (7, 'BTB-batch07', 1, 'k7', 2, 'FORWARD', 5, 'SENT', 1, 100000)`,
      );
      await seed([{ id: 700, price: 100_000, batch: 7 }]);
      await db.query(
        `INSERT INTO order_schema.branch_transfer_batch_items
          (batch_id, order_id, snapshot_price, snapshot_market_id, sent_at)
         VALUES (7, 700, 100000, 10, now())`,
      );

      await expect(
        service.deleteOrdersFromPost({
          post_id: '88',
          order_ids: ['700'],
          reason,
          requester,
        }),
      ).rejects.toBeInstanceOf(RpcException);

      expect((await orderRows())[0]).toMatchObject({
        is_deleted: false,
        current_batch_id: '7',
      });
      expect(
        await db.query(
          'SELECT order_count FROM order_schema.branch_transfer_batches',
        ),
      ).toEqual([{ order_count: 1 }]);
    });
  },
);
