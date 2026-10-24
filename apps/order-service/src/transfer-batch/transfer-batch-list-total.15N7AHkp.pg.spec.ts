import { DataSource } from 'typeorm';
import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
} from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';

/**
 * 15N7AHkp — GET /transfer-batches statussiz / PENDING: `meta.total` HAQIQIY.
 *
 * Ilgari bir yo'nalishdagi PENDING dublikatlar sahifa ichida (xotirada)
 * yig'ilardi va `total` = sahifadagi qatorlar soni edi. Endi yig'ish SQL'da
 * (NOT EXISTS yangiroq PENDING) — COUNT ham aynan shu shart bilan.
 *
 * Ishga tushirish (faqat lokal test bazasi):
 *   TRANSFER_BATCH_PG_TEST_URI=postgres://postgres@localhost:<port>/elchi_day1_test
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

const P = BranchTransferBatchStatus;

(localTestDatabase ? describe : describe.skip)(
  "15N7AHkp — haqiqiy Postgres: transfer-batches PENDING yig'ish va total",
  () => {
    let db: DataSource;
    let service: BranchTransferBatchService;
    let schemasCreated = false;
    let seq = 0;

    async function batch(row: {
      status: BranchTransferBatchStatus;
      source?: string;
      destination?: string;
      direction?: BranchTransferDirection;
      region?: string;
      createdAt: string;
      isDeleted?: boolean;
    }): Promise<string> {
      seq += 1;
      const direction = row.direction ?? BranchTransferDirection.FORWARD;
      const prefix =
        direction === BranchTransferDirection.RETURN ? 'BTR' : 'BTB';
      const saved = await db.getRepository(BranchTransferBatch).save({
        qr_code_token: `${prefix}-T${String(seq).padStart(6, '0')}`,
        request_key: `rk-${seq}`,
        source_branch_id: row.source ?? '10',
        destination_branch_id: row.destination ?? '20',
        direction,
        target_region_id: row.region ?? '1',
        status: row.status,
        isDeleted: row.isDeleted ?? false,
      });
      await db.query(
        `UPDATE order_schema.branch_transfer_batches SET "createdAt" = $1 WHERE id = $2`,
        [row.createdAt, saved.id],
      );
      return String(saved.id);
    }

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
      service = new BranchTransferBatchService(
        db,
        db.getRepository(BranchTransferBatch),
        db.getRepository(BranchTransferBatchItem),
        db.getRepository(BranchTransferBatchHistory),
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
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
        'TRUNCATE order_schema.branch_transfer_batches RESTART IDENTITY CASCADE',
      );
    });

    type ListResult = {
      data: {
        items: Array<{ id: string; status: string }>;
        meta: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      };
    };
    const list = (input: Record<string, unknown>) =>
      service.findBranchTransferBatches(input) as Promise<ListResult>;

    it('⭐ statussiz: total haqiqiy, sahifalar to‘liq, dublikat PENDING faqat eng yangisi, sahifalararo takror yo‘q', async () => {
      // K1 (10→20, FORWARD, hudud 1): 3 ta PENDING — faqat eng yangisi qoladi.
      const k1Old = await batch({
        status: P.PENDING,
        createdAt: '2026-10-20T08:00:00Z',
      });
      const k1Mid = await batch({
        status: P.PENDING,
        createdAt: '2026-10-21T08:00:00Z',
      });
      const k1New = await batch({
        status: P.PENDING,
        createdAt: '2026-10-22T08:00:00Z',
      });
      // O'chirilgan YANGIROQ PENDING k1New ni yashirmaydi.
      await batch({
        status: P.PENDING,
        createdAt: '2026-10-23T08:00:00Z',
        isDeleted: true,
      });
      // K2 (10→30) va K3 (RETURN 20→10) — boshqa yo'nalishlar, alohida qoladi.
      const k2 = await batch({
        status: P.PENDING,
        destination: '30',
        createdAt: '2026-10-19T08:00:00Z',
      });
      const k3 = await batch({
        status: P.PENDING,
        source: '20',
        destination: '10',
        direction: BranchTransferDirection.RETURN,
        createdAt: '2026-10-18T08:00:00Z',
      });
      // 25 SENT (bir xil yo'nalish — yig'ilmaydi), 2 RECEIVED, 1 CANCELLED.
      for (let i = 0; i < 25; i += 1) {
        await batch({
          status: P.SENT,
          createdAt: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(),
        });
      }
      await batch({ status: P.RECEIVED, createdAt: '2026-09-20T08:00:00Z' });
      await batch({ status: P.RECEIVED, createdAt: '2026-09-21T08:00:00Z' });
      await batch({ status: P.CANCELLED, createdAt: '2026-09-22T08:00:00Z' });

      const first = await list({ page: 1, limit: 10 });
      // 25 + 2 + 1 + 3 (k1New, k2, k3) = 31.
      expect(first.data.meta).toEqual({
        page: 1,
        limit: 10,
        total: 31,
        totalPages: 4,
      });

      const seen: string[] = [];
      for (let page = 1; page <= first.data.meta.totalPages; page += 1) {
        const res = await list({ page, limit: 10 });
        expect(res.data.meta.total).toBe(31);
        seen.push(...res.data.items.map((item) => String(item.id)));
      }
      expect(seen).toHaveLength(31);
      expect(new Set(seen).size).toBe(31);
      expect(seen).toEqual(expect.arrayContaining([k1New, k2, k3]));
      expect(seen).not.toContain(k1Old);
      expect(seen).not.toContain(k1Mid);
      // Tartib o'zgarmagan: createdAt DESC — eng yangi PENDING birinchi.
      expect(first.data.items[0].id).toBe(k1New);
    });

    it('⭐ status=PENDING: /batches «Yangi» tab soni — yo‘nalishlar soni (ko‘pi bilan 1 emas)', async () => {
      for (const destination of ['20', '30', '40']) {
        for (const day of ['20', '21']) {
          await batch({
            status: P.PENDING,
            destination,
            createdAt: `2026-10-${day}T08:00:00Z`,
          });
        }
      }

      const res = await list({ status: 'PENDING', page: 1, limit: 2 });

      expect(res.data.meta).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(res.data.items).toHaveLength(2);
      const second = await list({ status: 'PENDING', page: 2, limit: 2 });
      expect(second.data.items).toHaveLength(1);
    });

    it('status=SENT — yig‘ish qo‘llanmaydi (bir yo‘nalishdagi hammasi)', async () => {
      for (let i = 0; i < 3; i += 1) {
        await batch({
          status: P.SENT,
          createdAt: `2026-10-2${i}T08:00:00Z`,
        });
      }

      const res = await list({ status: 'SENT' });

      expect(res.data.meta.total).toBe(3);
      expect(res.data.items).toHaveLength(3);
    });

    it('date filtri: yangiroq PENDING oynadan tashqarida bo‘lsa — oynadagisi ko‘rinadi', async () => {
      const inWindow = await batch({
        status: P.PENDING,
        createdAt: '2026-10-21T06:00:00Z', // Toshkent 21-oktabr 11:00
      });
      await batch({ status: P.PENDING, createdAt: '2026-10-22T06:00:00Z' });

      const res = await list({ date: '2026-10-21' });

      expect(res.data.meta.total).toBe(1);
      expect(res.data.items.map((item) => String(item.id))).toEqual([inWindow]);
    });

    it('bir xil createdAt — kattaroq id qoladi (barqaror)', async () => {
      const a = await batch({
        status: P.PENDING,
        createdAt: '2026-10-21T08:00:00Z',
      });
      const b = await batch({
        status: P.PENDING,
        createdAt: '2026-10-21T08:00:00Z',
      });

      const res = await list({});

      expect(res.data.meta.total).toBe(1);
      expect(res.data.items.map((item) => String(item.id))).toEqual([
        String(Math.max(Number(a), Number(b))),
      ]);
    });

    it('manba filtri bilan ham total haqiqiy', async () => {
      await batch({ status: P.PENDING, createdAt: '2026-10-20T08:00:00Z' });
      await batch({ status: P.PENDING, createdAt: '2026-10-21T08:00:00Z' });
      await batch({
        status: P.PENDING,
        source: '11',
        createdAt: '2026-10-21T08:00:00Z',
      });
      await batch({ status: P.SENT, createdAt: '2026-10-19T08:00:00Z' });

      const res = await list({ source_branch_id: '10' });

      expect(res.data.meta.total).toBe(2);
    });
  },
);
