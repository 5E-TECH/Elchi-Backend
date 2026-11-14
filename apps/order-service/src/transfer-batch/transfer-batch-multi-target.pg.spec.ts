import { DataSource } from 'typeorm';
import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { TransferBatchRequestKeyPerTarget1716000000221 } from '../../../../migrations/1716000000221-TransferBatchRequestKeyPerTarget';
import { TransferBatchOnePendingForwardPerRoute1716000000222 } from '../../../../migrations/1716000000222-TransferBatchOnePendingForwardPerRoute';

/**
 * Filial paketi — HAQIQIY Postgres'da.
 *
 * 1) Xato (staging, 2026-11-14): HYBRID filial menejeri 5 ta viloyatdagi 5 ta
 *    yangi buyurtmani «Qabul qilish» qildi → `POST branches/transfer-batches`
 *    502. Har viloyatga alohida paket ochilib, hammasi bir xil `request_key`
 *    olardi, eski `UNIQUE (source_branch_id, request_key)` esa ikkinchi yangi
 *    paketda 23505 berardi (migratsiya 1716000000221).
 * 2) Dilshod (2026-11-14, /batches): «paketlar hamma viloyatniki umumiy 1 ta
 *    bo'lishi kerak» — filialdan HQ ga bitta yo'nalishga BITTA umumiy PENDING
 *    paket, viloyatga bog'lanmaydi; eski viloyatli PENDING paketlar
 *    birlashtiriladi (migratsiya 1716000000222). Qaytarish paketi — har manzil
 *    filialiga alohida (o'zgarmagan).
 *
 * Ishga tushirish (faqat lokal test bazasi):
 *   TRANSFER_BATCH_PG_TEST_URI=postgres://<user>@localhost:<port>/elchi_day1_test
 */
const uri = process.env.TRANSFER_BATCH_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_day1_test'
  );
})();

const SOURCE = '10';
const HQ = '1';

(localTestDatabase ? describe : describe.skip)(
  'filial paketi — bir so‘rovda bir necha viloyat / manzil (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: BranchTransferBatchService;
    let schemasCreated = false;
    let seq = 0;

    const order = async (row: Partial<Order>): Promise<string> => {
      seq += 1;
      const saved = await db.getRepository(Order).save({
        market_id: '3',
        customer_id: String(1000 + seq),
        branch_id: SOURCE,
        status: Order_status.NEW,
        total_price: 520000,
        ...row,
      } as Order);
      return String(saved.id);
    };

    const batchedCount = async (ids: string[]): Promise<number> => {
      const rows = await db.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM order_schema.orders
          WHERE id = ANY($1::bigint[]) AND current_batch_id IS NOT NULL`,
        [ids],
      );
      return rows[0].n;
    };

    type CreateResult = {
      statusCode: number;
      data: {
        idempotent: boolean;
        batches: Array<{
          id: string;
          target_region_id: string | null;
          region_ids: string[];
          order_count: number;
          total_price: number;
          destination_branch_id: string;
          request_key: string;
          items: Array<{ order_id: string }>;
        }>;
      };
    };

    const forward = (orderIds: string[], requestKey: string) =>
      service.createBranchTransferBatches({
        source_branch_id: SOURCE,
        destination_branch_id: HQ,
        direction: BranchTransferDirection.FORWARD,
        order_ids: orderIds,
        request_key: requestKey,
        requester_id: '25',
      }) as Promise<CreateResult>;

    const runMigrations = async () => {
      const runner = db.createQueryRunner();
      try {
        await new TransferBatchRequestKeyPerTarget1716000000221().up(runner);
        await new TransferBatchOnePendingForwardPerRoute1716000000222().up(
          runner,
        );
      } finally {
        await runner.release();
      }
    };

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
        ],
        synchronize: false,
      });
      await db.initialize();
      for (const schema of ['order_schema', 'branch_schema']) {
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      schemasCreated = true;
      await db.synchronize();
      // Prod holati: jadvalda migratsiya 1713203000000 qo'ygan eski CONSTRAINT
      // turadi, viloyat majburiy, entity'dagi yangi indekslar hali yo'q — so'ng
      // HAQIQIY migratsiyalar.
      await db.query(
        'DROP INDEX IF EXISTS order_schema."UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET"',
      );
      await db.query(
        'DROP INDEX IF EXISTS order_schema."UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE"',
      );
      await db.query(
        `ALTER TABLE order_schema.branch_transfer_batches
           ALTER COLUMN target_region_id SET NOT NULL`,
      );
      await db.query(
        `ALTER TABLE order_schema.branch_transfer_batches
           ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
           UNIQUE ("source_branch_id", "request_key")`,
      );
      await runMigrations();
      // Qayta yurgizish xatosiz (IF EXISTS / IF NOT EXISTS).
      await runMigrations();
      service = new BranchTransferBatchService(
        db,
        db.getRepository(BranchTransferBatch),
        db.getRepository(BranchTransferBatchItem),
        db.getRepository(BranchTransferBatchHistory),
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        { log: () => Promise.resolve() } as never,
        {
          auditActor: () => ({}),
          toTrackingRole: () => 'manager',
          createTrackingEvent: () => Promise.resolve(),
          createCustodyEvent: () => Promise.resolve(),
        } as never,
      );
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemasCreated) {
          for (const schema of ['order_schema', 'branch_schema']) {
            await db.query(`DROP SCHEMA "${schema}" CASCADE`);
          }
        }
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await db.query(
        'TRUNCATE order_schema.branch_transfer_batches, order_schema.orders RESTART IDENTITY CASCADE',
      );
    });

    it('migratsiyalardan keyin: eski cheklov yo‘q; so‘rov + manzil + viloyat; yo‘nalishga bitta PENDING filial paketi', async () => {
      const rows = await db.query<Array<{ name: string; def: string }>>(
        `SELECT indexname AS name, indexdef AS def FROM pg_indexes
          WHERE schemaname = 'order_schema' AND tablename = 'branch_transfer_batches'
            AND indexname LIKE 'UQ_BRANCH_TRANSFER_BATCHES_%'
          ORDER BY indexname`,
      );
      expect(rows.map((row) => row.name)).toEqual([
        'UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE',
        'UQ_BRANCH_TRANSFER_BATCHES_QR_CODE_TOKEN',
        'UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET',
      ]);
      expect(rows[0].def).toContain(
        '(source_branch_id, destination_branch_id)',
      );
      expect(rows[0].def).toContain("'PENDING'");
      expect(rows[0].def).toContain("'FORWARD'");
      expect(rows[2].def).toContain(
        '(source_branch_id, request_key, destination_branch_id, target_region_id)',
      );
      const nullable = await db.query<Array<{ is_nullable: string }>>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'order_schema'
            AND table_name = 'branch_transfer_batches'
            AND column_name = 'target_region_id'`,
      );
      expect(nullable[0].is_nullable).toBe('YES');
    });

    it('⭐ 5 ta viloyatdagi 6 ta yangi buyurtma — BITTA umumiy paket, hammasi biriktiriladi', async () => {
      const regions = ['15', '11', '12', '13', '14', '15'];
      const ids: string[] = [];
      for (const region of regions)
        ids.push(await order({ region_id: region }));

      const res = await forward(ids, 'req_multi_region_1');

      expect(res.statusCode).toBe(201);
      expect(res.data.idempotent).toBe(false);
      expect(res.data.batches).toHaveLength(1);
      const [batch] = res.data.batches;
      expect(batch.target_region_id).toBeNull();
      expect(batch.region_ids).toEqual(['11', '12', '13', '14', '15']);
      expect(batch.order_count).toBe(6);
      expect(batch.total_price).toBe(6 * 520000);
      expect(batch.items.map((item) => item.order_id).sort()).toEqual(
        [...ids].sort(),
      );
      expect(await batchedCount(ids)).toBe(6);
    });

    it('keyingi qabul — o‘sha PENDING paketga qo‘shiladi (yangi paket ochilmaydi)', async () => {
      const first = [
        await order({ region_id: '11' }),
        await order({ region_id: '12' }),
      ];
      const created = await forward(first, 'req_first_accept');

      const next = [
        await order({ region_id: '12' }),
        await order({ region_id: '13' }),
      ];
      const res = await forward(next, 'req_second_accept');

      expect(res.data.batches.map((batch) => batch.id)).toEqual(
        created.data.batches.map((batch) => batch.id),
      );
      expect(res.data.batches[0].order_count).toBe(4);
      expect(res.data.batches[0].region_ids).toEqual(['11', '12', '13']);
      expect(await batchedCount([...first, ...next])).toBe(4);
      expect(
        await db.getRepository(BranchTransferBatch).count({
          where: { status: BranchTransferBatchStatus.PENDING },
        }),
      ).toBe(1);
    });

    it('baza: bitta yo‘nalishga ikkinchi PENDING filial paketi ochilmaydi (parallel so‘rov)', async () => {
      await forward([await order({ region_id: '11' })], 'req_route_owner');

      await expect(
        db.query(
          `INSERT INTO order_schema.branch_transfer_batches
             (qr_code_token, source_branch_id, request_key, destination_branch_id,
              direction, target_region_id, status)
           VALUES ('BTB-PARALLEL01', $1, 'req_parallel', $2, 'FORWARD', NULL, 'PENDING')`,
          [SOURCE, HQ],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('umumiy paket HQ da qabul qilinadi — barcha viloyat buyurtmalari RECEIVED (tranzit yo‘q)', async () => {
      const ids = [
        await order({ region_id: '11' }),
        await order({ region_id: '12' }),
        await order({ region_id: '13' }),
      ];
      const res = await forward(ids, 'req_receive_mixed');
      const batchId = res.data.batches[0].id;
      await db.query(
        `UPDATE order_schema.branch_transfer_batches
            SET status = 'SENT', sent_at = now() WHERE id = $1`,
        [batchId],
      );
      await db.query(
        `UPDATE order_schema.branch_transfer_batch_items
            SET sent_at = now() WHERE batch_id = $1`,
        [batchId],
      );

      await service.receiveBranchTransferBatch({
        batch_id: batchId,
        requester_id: '7',
        requester_roles: ['admin'],
      });

      const rows = await db.query<
        Array<{ status: string; branch_id: string; current_batch_id: null }>
      >(
        `SELECT status, branch_id, current_batch_id FROM order_schema.orders
          WHERE id = ANY($1::bigint[])`,
        [ids],
      );
      expect(rows).toEqual(
        ids.map(() => ({
          status: Order_status.RECEIVED,
          branch_id: HQ,
          current_batch_id: null,
        })),
      );
    });

    it('logist doirasi: umumiy paket ichida o‘z viloyati buyurtmasi bo‘lsa ko‘rinadi', async () => {
      await forward(
        [await order({ region_id: '11' }), await order({ region_id: '12' })],
        'req_logist_scope',
      );

      type ListResult = {
        data: {
          items: Array<{ region_ids: string[] }>;
          meta: { total: number };
        };
      };
      const mine = (await service.findBranchTransferBatches({
        target_region_ids: ['12', '40'],
      })) as ListResult;
      const other = (await service.findBranchTransferBatches({
        target_region_ids: ['40'],
      })) as ListResult;
      const single = (await service.findBranchTransferBatches({
        target_region_id: '11',
      })) as ListResult;

      expect(mine.data.meta.total).toBe(1);
      expect(mine.data.items[0].region_ids).toEqual(['11', '12']);
      expect(other.data.meta.total).toBe(0);
      expect(single.data.meta.total).toBe(1);
    });

    it('⭐ migratsiya: yo‘nalishdagi eski viloyatli PENDING paketlar eng eskisiga birlashadi', async () => {
      await db.query(
        'DROP INDEX order_schema."UQ_BRANCH_TRANSFER_BATCHES_PENDING_FORWARD_ROUTE"',
      );
      const insertBatch = async (
        token: string,
        region: string,
        createdAt: string,
        status = 'PENDING',
        source = SOURCE,
      ): Promise<string> => {
        const rows = await db.query<Array<{ id: string }>>(
          `INSERT INTO order_schema.branch_transfer_batches
             (qr_code_token, source_branch_id, request_key, destination_branch_id,
              direction, target_region_id, status, "createdAt")
           VALUES ($1, $2, $1, $3, 'FORWARD', $4, $5, $6) RETURNING id`,
          [token, source, HQ, region, status, createdAt],
        );
        return String(rows[0].id);
      };
      const attach = async (batchId: string, region: string) => {
        const orderId = await order({ region_id: region });
        await db.query(
          'UPDATE order_schema.orders SET current_batch_id = $1 WHERE id = $2',
          [batchId, orderId],
        );
        await db.query(
          `INSERT INTO order_schema.branch_transfer_batch_items
             (batch_id, order_id, snapshot_price, snapshot_market_id)
           VALUES ($1, $2, 520000, '3')`,
          [batchId, orderId],
        );
        return orderId;
      };
      // B-20 Jizzax (eng eski), B-21 Toshkent sh., B-22 Qoraqalpog'iston.
      const jizzax = await insertBatch(
        'BTB-OLD00020',
        '11',
        '2026-11-13T08:00:00Z',
      );
      const toshkent = await insertBatch(
        'BTB-OLD00021',
        '12',
        '2026-11-13T09:00:00Z',
      );
      const qqr = await insertBatch(
        'BTB-OLD00022',
        '13',
        '2026-11-14T07:00:00Z',
      );
      // Jo'natilgan paket va boshqa filial paketi — tegilmaydi.
      const sent = await insertBatch(
        'BTB-SENT0001',
        '12',
        '2026-11-12T08:00:00Z',
        'SENT',
      );
      const otherSource = await insertBatch(
        'BTB-OTHER001',
        '12',
        '2026-11-12T08:00:00Z',
        'PENDING',
        '99',
      );
      const orderIds = [
        await attach(jizzax, '11'),
        await attach(toshkent, '12'),
        await attach(toshkent, '12'),
        await attach(qqr, '13'),
      ];
      await attach(sent, '12');
      await attach(otherSource, '12');

      await runMigrations();

      const batches = await db.query<
        Array<{
          id: string;
          status: string;
          is_deleted: boolean;
          order_count: number;
          total_price: number;
          target_region_id: string | null;
        }>
      >(
        `SELECT id, status, is_deleted, order_count, total_price, target_region_id
           FROM order_schema.branch_transfer_batches ORDER BY id`,
      );
      const byId = new Map(batches.map((row) => [String(row.id), row]));
      expect(byId.get(jizzax)).toMatchObject({
        status: 'PENDING',
        is_deleted: false,
        order_count: 4,
        total_price: 4 * 520000,
        target_region_id: null,
      });
      expect(byId.get(toshkent)).toMatchObject({
        is_deleted: true,
        order_count: 0,
      });
      expect(byId.get(qqr)).toMatchObject({ is_deleted: true, order_count: 0 });
      expect(byId.get(sent)).toMatchObject({
        status: 'SENT',
        is_deleted: false,
      });
      expect(byId.get(otherSource)).toMatchObject({
        is_deleted: false,
        target_region_id: '12',
      });

      const moved = await db.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM order_schema.orders
          WHERE id = ANY($1::bigint[]) AND current_batch_id = $2`,
        [orderIds, jizzax],
      );
      expect(moved[0].n).toBe(4);
      const items = await db.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM order_schema.branch_transfer_batch_items
          WHERE batch_id = $1 AND is_deleted = false`,
        [jizzax],
      );
      expect(items[0].n).toBe(4);
      const history = await db.query<
        Array<{ batch_id: string; notes: string }>
      >(
        `SELECT batch_id, notes FROM order_schema.branch_transfer_batch_history
          ORDER BY id`,
      );
      expect(history).toEqual(
        expect.arrayContaining([
          {
            batch_id: jizzax,
            notes: `[STEP] BATCHES_MERGED #${toshkent}, #${qqr}`,
          },
          { batch_id: toshkent, notes: `[STEP] MERGED_INTO #${jizzax}` },
          { batch_id: qqr, notes: `[STEP] MERGED_INTO #${jizzax}` },
        ]),
      );

      // Keyingi qabul — birlashgan paketga.
      const next = await forward(
        [await order({ region_id: '14' })],
        'req_after_merge',
      );
      expect(next.data.batches.map((batch) => batch.id)).toEqual([jizzax]);
      expect(next.data.batches[0].region_ids).toEqual(['11', '12', '13', '14']);
    });

    it('xuddi shu request_key qayta kelsa — idempotent: yangi paket yo‘q, avvalgi paketlar qaytadi', async () => {
      const ids = [
        await order({ region_id: '11' }),
        await order({ region_id: '12' }),
      ];
      const created = await forward(ids, 'req_retry_same_key');
      const replay = await forward(ids, 'req_retry_same_key');

      expect(replay.data.idempotent).toBe(true);
      expect(replay.data.batches.map((batch) => batch.id)).toEqual(
        created.data.batches.map((batch) => batch.id),
      );
      expect(await db.getRepository(BranchTransferBatch).count()).toBe(1);
    });

    it('qaytarish paketi ikki xil uy filialiga — bitta so‘rovda ikkita paket', async () => {
      const held = {
        status: Order_status.CANCELLED,
        branch_id: '30',
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: SOURCE,
        region_id: '11',
      };
      const ids = [
        await order({ ...held, home_branch_id: '30' }),
        await order({ ...held, home_branch_id: '31' }),
        await order({ ...held, home_branch_id: '31' }),
      ];

      const res = (await service.createBranchReturnBatches({
        source_branch_id: SOURCE,
        order_ids: ids,
        request_key: 'req_return_two_homes',
        requester_id: '25',
      })) as CreateResult;

      expect(
        res.data.batches.map((batch) => batch.destination_branch_id).sort(),
      ).toEqual(['30', '31']);
      expect(await batchedCount(ids)).toBe(3);
    });
  },
);
