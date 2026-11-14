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

/**
 * Filial paketi bir necha viloyatga (qaytarish paketi — bir necha manzil
 * filialiga) bo'linganda HAQIQIY Postgres'da yaratiladi.
 *
 * Xato (staging, 2026-11-14): HYBRID filial menejeri 5 ta viloyatdagi 5 ta
 * yangi buyurtmani «Qabul qilish» qildi → `POST branches/transfer-batches`
 * 502. Bitta so'rovning har yangi paketi bir xil `request_key` oladi, eski
 * `UNIQUE (source_branch_id, request_key)` esa ikkinchi yangi paketda 23505
 * berardi; xato RpcException'siz otilib, branch-service uni 502 «Buyurtmalar
 * xizmati javob bermadi» qilardi. Bitta viloyat (yoki faqat bitta YANGI
 * viloyat) bo'lsa ishlardi — shuning uchun «oz bo'lsa ishlaydi» ko'rinardi.
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
          target_region_id: string;
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
      // turadi (entity'dagi yangi indeks hali yo'q) — so'ng HAQIQIY migratsiya.
      await db.query(
        'DROP INDEX IF EXISTS order_schema."UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET"',
      );
      await db.query(
        `ALTER TABLE order_schema.branch_transfer_batches
           ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
           UNIQUE ("source_branch_id", "request_key")`,
      );
      const migration = new TransferBatchRequestKeyPerTarget1716000000221();
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
        // Qayta yurgizish xatosiz (IF EXISTS / IF NOT EXISTS).
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      service = new BranchTransferBatchService(
        db,
        db.getRepository(BranchTransferBatch),
        db.getRepository(BranchTransferBatchItem),
        db.getRepository(BranchTransferBatchHistory),
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        { log: () => Promise.resolve() } as never,
        { auditActor: () => ({}) } as never,
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

    it('migratsiyadan keyin: eski cheklov yo‘q, yangi yagonalik — so‘rov + manzil + viloyat', async () => {
      const rows = await db.query<Array<{ name: string; def: string }>>(
        `SELECT indexname AS name, indexdef AS def FROM pg_indexes
          WHERE schemaname = 'order_schema' AND tablename = 'branch_transfer_batches'
            AND indexname LIKE 'UQ_BRANCH_TRANSFER_BATCHES_%'
          ORDER BY indexname`,
      );
      expect(rows.map((row) => row.name)).toEqual([
        'UQ_BRANCH_TRANSFER_BATCHES_QR_CODE_TOKEN',
        'UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET',
      ]);
      expect(rows[1].def).toContain(
        '(source_branch_id, request_key, destination_branch_id, target_region_id)',
      );
    });

    it('⭐ 5 ta viloyatdagi 6 ta yangi buyurtma — bitta so‘rovda 5 ta paket, hammasi biriktiriladi', async () => {
      const regions = ['11', '12', '13', '14', '15', '15'];
      const ids: string[] = [];
      for (const region of regions)
        ids.push(await order({ region_id: region }));

      const res = await forward(ids, 'req_multi_region_1');

      expect(res.statusCode).toBe(201);
      expect(res.data.idempotent).toBe(false);
      expect(
        res.data.batches.map((batch) => batch.target_region_id).sort(),
      ).toEqual(['11', '12', '13', '14', '15']);
      expect(
        res.data.batches.flatMap((batch) =>
          batch.items.map((item) => item.order_id),
        ),
      ).toHaveLength(6);
      expect(await batchedCount(ids)).toBe(6);
    });

    it('bir viloyatda PENDING paket bor, ikkitasi yangi — eskisiga qo‘shiladi, ikkita yangi yaratiladi', async () => {
      const first = await order({ region_id: '11' });
      await forward([first], 'req_existing_11');

      const ids = [
        await order({ region_id: '11' }),
        await order({ region_id: '12' }),
        await order({ region_id: '13' }),
      ];
      const res = await forward(ids, 'req_mixed_regions');

      expect(res.data.batches).toHaveLength(3);
      expect(await batchedCount([first, ...ids])).toBe(4);
      const pending = await db.getRepository(BranchTransferBatch).count({
        where: { status: BranchTransferBatchStatus.PENDING },
      });
      expect(pending).toBe(3);
    });

    it('xuddi shu request_key qayta kelsa — idempotent: yangi paket yo‘q, avvalgi paketlar qaytadi', async () => {
      const ids = [
        await order({ region_id: '11' }),
        await order({ region_id: '12' }),
      ];
      const created = await forward(ids, 'req_retry_same_key');
      const replay = await forward(ids, 'req_retry_same_key');

      expect(replay.data.idempotent).toBe(true);
      expect(replay.data.batches.map((batch) => batch.id).sort()).toEqual(
        created.data.batches.map((batch) => batch.id).sort(),
      );
      expect(await db.getRepository(BranchTransferBatch).count()).toBe(2);
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
