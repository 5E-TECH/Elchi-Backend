import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { ExtraCostApprovalVoidReversed1716000000206 } from '../../../../migrations/1716000000206-ExtraCostApprovalVoidReversed';
import { ExtraCostAutoApproveFrom1716000000208 } from '../../../../migrations/1716000000208-ExtraCostAutoApproveFrom';

/**
 * AFZaUUi5 — migratsiya 208 haqiqiy Postgres'da (BOT_PG_TEST_URI — faqat
 * lokal baza). O'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • faqat ustun va indeks qo'shiladi — mavjud qatorlar (ochiq so'rovlar,
 *    eslatma, `createdAt`) o'zgarmaydi; `auto_approve_from` NULL: muddat
 *    boshini skaner birinchi tikda belgilaydi (extra-cost-decision.pg.spec);
 *  • `auto_approve_from` da sukut yo'q — eski kod yozgan qator ham NULL;
 *    `auto_attempts` 0, `auto_retry_at` NULL;
 *  • qayta yurgizish hech narsani o'zgartirmaydi; down() — indeks va ustunlar.
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();

type Row = {
  id: string;
  status: string;
  is_deleted: boolean;
  createdAt: Date;
  reminder_sent_at: Date | null;
  auto_approve_from: Date | null;
  auto_attempts: number | null;
  auto_retry_at: Date | null;
};

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 208 — muddat boshi ustunlari, qatorlar o‘zgarmaydi (haqiqiy Postgres)',
  () => {
    jest.setTimeout(30_000);
    const dbName = `spec_xc_auto_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new ExtraCostAutoApproveFrom1716000000208();

    /** TypeORM kabi: bitta tranzaksiyada. */
    const run = async (direction: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration[direction](runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    const OLD = new Date('2026-11-01T10:00:00Z');
    const approval = async (row: {
      order: number;
      status: string;
      isDeleted?: boolean;
    }): Promise<string> => {
      const [saved]: Array<{ id: string }> = await db.query(
        `INSERT INTO order_schema.order_extra_cost_approvals
           (order_id, market_id, requested_by_user_id, action, amount, operation_payload,
            status, is_deleted, "createdAt", reminder_sent_at)
         VALUES ($1, 501, 289, 'sell', 10000, '{}'::jsonb, $2, $3, $4, $5)
         RETURNING id::text AS id`,
        [
          row.order,
          row.status,
          row.isDeleted ?? false,
          OLD,
          new Date('2026-11-01T10:20:00Z'),
        ],
      );
      return saved.id;
    };
    /** `migrated` — migratsiyadan oldin yangi ustunlar hali yo'q. */
    const rows = async (migrated = true): Promise<Record<string, Row>> => {
      const columns = migrated
        ? 'auto_approve_from, auto_attempts, auto_retry_at'
        : 'NULL::timestamptz AS auto_approve_from, NULL::int AS auto_attempts, NULL::timestamptz AS auto_retry_at';
      const all: Row[] = await db.query(
        `SELECT id::text AS id, status, is_deleted, "createdAt", reminder_sent_at, ${columns}
           FROM order_schema.order_extra_cost_approvals ORDER BY id`,
      );
      return Object.fromEntries(all.map((row) => [row.id, row]));
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri!);
      url.pathname = `/${dbName}`;
      db = new DataSource({ type: 'postgres', url: url.toString() });
      await db.initialize();
    });

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.destroy();
      }
    });

    it('jadval yo‘q — xatosiz, hech narsa qilmaydi', async () => {
      await db.query('CREATE SCHEMA order_schema');
      await expect(run('up')).resolves.toBeUndefined();
    });

    describe('mavjud so‘rovlar', () => {
      const ids: Record<string, string> = {};
      let before: Record<string, Row>;
      let after: Record<string, Row>;

      beforeAll(async () => {
        const statuses = Object.values(Order_status)
          .map((status) => `'${status}'`)
          .join(', ');
        await db.query(
          `CREATE TYPE order_schema.orders_status_enum AS ENUM (${statuses})`,
        );
        await db.query(`
          CREATE TABLE order_schema.orders (
            id bigint PRIMARY KEY,
            status order_schema.orders_status_enum NOT NULL DEFAULT 'waiting',
            is_deleted boolean NOT NULL DEFAULT false
          )`);
        await db.query(`
          CREATE TABLE order_schema.order_tracking (
            id bigserial PRIMARY KEY,
            order_id bigint NOT NULL,
            from_status order_schema.orders_status_enum,
            to_status order_schema.orders_status_enum NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )`);
        const runner = db.createQueryRunner();
        try {
          await new CreateOrderExtraCostApprovals1716000000026().up(runner);
          await new ExtraCostAutoApprove1716000000123().up(runner);
          await new ExtraCostApprovalVoidReversed1716000000206().up(runner);
        } finally {
          await runner.release();
        }
        await db.query(
          `INSERT INTO order_schema.orders (id, status) VALUES (1, 'waiting'), (2, 'waiting'), (3, 'sold'), (4, 'waiting')`,
        );
        ids.oldPending = await approval({ order: 1, status: 'pending' });
        ids.deletedPending = await approval({
          order: 2,
          status: 'pending',
          isDeleted: true,
        });
        ids.approved = await approval({ order: 3, status: 'approved' });
        ids.voided = await approval({ order: 2, status: 'void' });
        ids.rejected = await approval({ order: 4, status: 'rejected' });
      });

      it('migratsiya o‘tadi', async () => {
        before = await rows(false);
        await run('up');
        after = await rows();
      });

      it('⭐ mavjud qatorlar o‘zgarmaydi (ochiq 3 kunlik so‘rov ham): muddat boshi NULL — skaner belgilaydi', () => {
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        for (const key of Object.keys(ids)) {
          expect(after[ids[key]]).toEqual({
            ...before[ids[key]],
            auto_approve_from: null,
            auto_attempts: 0,
            auto_retry_at: null,
          });
        }
        expect(after[ids.oldPending]).toMatchObject({
          status: 'pending',
          createdAt: OLD,
          reminder_sent_at: new Date('2026-11-01T10:20:00Z'),
        });
      });

      it('⭐ yangi so‘rov (eski kod ham): auto_approve_from sukutsiz — NULL; auto_attempts 0', async () => {
        const [row]: Array<{
          from: Date | null;
          attempts: number;
          retry: Date | null;
        }> = await db.query(
          `INSERT INTO order_schema.order_extra_cost_approvals
             (order_id, market_id, requested_by_user_id, action, amount, operation_payload, status)
           VALUES (4, 501, 289, 'sell', 10000, '{}'::jsonb, 'pending')
           RETURNING auto_approve_from AS "from",
                     auto_attempts AS attempts, auto_retry_at AS retry`,
        );
        expect(row).toEqual({ from: null, attempts: 0, retry: null });
        const [column]: Array<{
          is_nullable: string;
          column_default: unknown;
        }> = await db.query(
          `SELECT is_nullable, column_default FROM information_schema.columns
              WHERE table_schema = 'order_schema'
                AND table_name = 'order_extra_cost_approvals'
                AND column_name = 'auto_approve_from'`,
        );
        expect(column).toEqual({ is_nullable: 'YES', column_default: null });
      });

      it('skaner indeksi qo‘yiladi', async () => {
        const indexes: unknown[] = await db.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_EXTRA_COST_PENDING_AUTO_FROM'`,
        );
        expect(indexes).toHaveLength(1);
      });

      it('⭐ qayta yurgizish hech narsani o‘zgartirmaydi', async () => {
        const once = await rows();
        await run('up');
        expect(await rows()).toEqual(once);
      });

      it('down(): indeks va ustunlar olib tashlanadi', async () => {
        await run('down');
        const columns: unknown[] = await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'order_schema'
              AND table_name = 'order_extra_cost_approvals'
              AND column_name IN ('auto_approve_from', 'auto_attempts', 'auto_retry_at')`,
        );
        expect(columns).toEqual([]);
        const indexes: unknown[] = await db.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_EXTRA_COST_PENDING_AUTO_FROM'`,
        );
        expect(indexes).toEqual([]);
      });
    });
  },
);
