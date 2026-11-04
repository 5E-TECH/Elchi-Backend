import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { ExtraCostApprovalVoidReversed1716000000206 } from '../../../../migrations/1716000000206-ExtraCostApprovalVoidReversed';

/**
 * hwTkXsGi — migratsiya 206 haqiqiy Postgres'da (BOT_PG_TEST_URI — faqat
 * lokal baza; CI'dagi pg job'i). O'z vaqtinchalik bazasini yaratadi va oxirida
 * o'chiradi.
 *
 *  • buyurtmasi «kutilmoqda» bo'lmagan (sotilgan / o'chirilgan / yo'q)
 *    `pending` → `void`;
 *  • C holati: `approved`, buyurtma hali «kutilmoqda», amal yozilmagan
 *    (tracking'da o'tish yo'q VA finance'da tasdiq tokeni yo'q) → `pending`,
 *    qaror maydonlari tozalanadi, `createdAt` yangilanadi;
 *    shu buyurtmada boshqa ochiq (yoki yangiroq C) so'rov bo'lsa — `void`;
 *  • bitta buyurtmada bir nechta `pending` — eng yangisi qoladi;
 *  • qolgan qatorlar tegilmaydi; partial unique indeks qo'yiladi;
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
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_comment: string | null;
  auto_approved: boolean;
  reminder_sent_at: Date | null;
  createdAt: Date;
  closed_reason: string | null;
  closed_at: Date | null;
};

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 206 — osilgan qo`shimcha xarajat so`rovlari (haqiqiy Postgres)',
  () => {
    jest.setTimeout(30_000);
    const dbName = `spec_xc_void_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new ExtraCostApprovalVoidReversed1716000000206();

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
    const order = (id: number, status: string, isDeleted = false) =>
      db.query(
        `INSERT INTO order_schema.orders (id, status, is_deleted) VALUES ($1, $2, $3)`,
        [id, status, isDeleted],
      );
    const approval = async (row: {
      order: number;
      status: string;
      action?: string;
      createdAt?: Date;
      isDeleted?: boolean;
    }): Promise<string> => {
      const decided = row.status !== 'pending';
      const [saved]: Array<{ id: string }> = await db.query(
        `INSERT INTO order_schema.order_extra_cost_approvals
           (order_id, market_id, requested_by_user_id, action, amount, operation_payload,
            status, is_deleted, "createdAt", decided_by_user_id, decided_at,
            decision_comment, auto_approved, reminder_sent_at)
         VALUES ($1, 501, 289, $2, 10000, '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::text AS id`,
        [
          row.order,
          row.action ?? 'sell',
          row.status,
          row.isDeleted ?? false,
          row.createdAt ?? OLD,
          decided ? 501 : null,
          decided ? new Date('2026-11-01T11:00:00Z') : null,
          decided ? 'izoh' : null,
          false,
          new Date('2026-11-01T10:20:00Z'),
        ],
      );
      return saved.id;
    };
    const tracking = (orderId: number, from: string, to: string, at: Date) =>
      db.query(
        `INSERT INTO order_schema.order_tracking (order_id, from_status, to_status, created_at)
         VALUES ($1, $2, $3, $4)`,
        [orderId, from, to, at],
      );
    /** `closed` — migratsiyadan oldin bu ustunlar hali yo'q (NULL deb o'qiladi). */
    const rows = async (closed = true): Promise<Record<string, Row>> => {
      const closedColumns = closed
        ? 'closed_reason, closed_at'
        : 'NULL::text AS closed_reason, NULL::timestamptz AS closed_at';
      const all: Row[] = await db.query(
        `SELECT id::text AS id, status, decided_by_user_id::text AS decided_by_user_id,
                decided_at, decision_comment, auto_approved, reminder_sent_at,
                "createdAt", ${closedColumns}
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

    describe('eski kod qoldirgan qatorlar', () => {
      const ids: Record<string, string> = {};

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
            status order_schema.orders_status_enum NOT NULL,
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
        await db.query('CREATE SCHEMA finance_schema');
        await db.query(`
          CREATE TABLE finance_schema.cashbox_history (
            id bigserial PRIMARY KEY,
            dedup_epoch varchar(120) NULL
          )`);
        const runner = db.createQueryRunner();
        try {
          await new CreateOrderExtraCostApprovals1716000000026().up(runner);
          await new ExtraCostAutoApprove1716000000123().up(runner);
        } finally {
          await runner.release();
        }

        // 2-band: buyurtma «kutilmoqda» emas.
        await order(1, 'sold');
        ids.soldPending = await approval({ order: 1, status: 'pending' });
        await order(2, 'waiting', true);
        ids.deletedOrderPending = await approval({
          order: 2,
          status: 'pending',
        });
        ids.missingOrderPending = await approval({
          order: 999,
          status: 'pending',
        });
        // Tegilmaydi: kutilayotgan buyurtmadagi yagona ochiq so'rov.
        await order(3, 'waiting');
        ids.livePending = await approval({ order: 3, status: 'pending' });

        // 3-band: C holati — tasdiqlandi, sotuv yozilmagan.
        await order(4, 'waiting');
        ids.cState = await approval({ order: 4, status: 'approved' });
        // Bekor qilishda faqat `cancelled` ga o'tish hisoblanadi: sotuv
        // o'tishi (keyin rollback) bekor so'rovini «bajarilgan» qilmaydi —
        // lekin holat so'rovdan keyin o'zgargan: eskirgan, `void` (qayta
        // ochilsa `createdAt` yangilanib, darvoza o'tib ketardi).
        await order(5, 'waiting');
        ids.cStateCancel = await approval({
          order: 5,
          status: 'approved',
          action: 'cancel',
        });
        await tracking(5, 'waiting', 'sold', new Date('2026-11-01T12:00:00Z'));
        await tracking(5, 'sold', 'waiting', new Date('2026-11-01T13:00:00Z'));
        // Tegilmaydi: amal tracking'da bor (sotilib, keyin qaytarilgan).
        await order(6, 'waiting');
        ids.executedThenRolledBack = await approval({
          order: 6,
          status: 'approved',
        });
        await tracking(6, 'waiting', 'sold', new Date('2026-11-01T12:00:00Z'));
        await tracking(6, 'sold', 'waiting', new Date('2026-11-01T13:00:00Z'));
        // Tegilmaydi: tracking yo'q, lekin finance'da shu tasdiq tokeni bor.
        await order(7, 'waiting');
        ids.financeLegs = await approval({ order: 7, status: 'approved' });
        await db.query(
          `INSERT INTO finance_schema.cashbox_history (dedup_epoch) VALUES ($1)`,
          [`req:extra-cost-approval:${ids.financeLegs}`],
        );
        // 3a: C holati + shu buyurtmada ochiq so'rov — C void, ochig'i qoladi.
        await order(8, 'waiting');
        ids.cStateWithPending = await approval({
          order: 8,
          status: 'approved',
        });
        ids.pendingNextToC = await approval({
          order: 8,
          status: 'pending',
          createdAt: new Date('2026-11-02T10:00:00Z'),
        });
        // 3a: ikkita C holati — eskisi void, yangisi pending.
        await order(9, 'waiting');
        ids.olderC = await approval({ order: 9, status: 'approved' });
        ids.newerC = await approval({
          order: 9,
          status: 'approved',
          createdAt: new Date('2026-11-02T10:00:00Z'),
        });

        // 3: bekor qilish C holati, holat o'zgarmagan — qayta pending.
        await order(11, 'waiting');
        ids.cStateCancelFresh = await approval({
          order: 11,
          status: 'approved',
          action: 'cancel',
        });
        // 3a: sotuv C holati, keyin filialga qaytib qayta jo'natilgan — void.
        await order(12, 'waiting');
        ids.cStateRedispatched = await approval({
          order: 12,
          status: 'approved',
        });
        await tracking(
          12,
          'waiting',
          'on the road',
          new Date('2026-11-01T12:00:00Z'),
        );
        await tracking(
          12,
          'on the road',
          'waiting',
          new Date('2026-11-01T13:00:00Z'),
        );
        // Tegilmaydi (darvoza ham hisoblamaydi): from = to yozuvi.
        await order(13, 'waiting');
        ids.cStateSameStatusRow = await approval({
          order: 13,
          status: 'approved',
        });
        await tracking(
          13,
          'waiting',
          'waiting',
          new Date('2026-11-01T12:00:00Z'),
        );

        // 4-band: bitta buyurtmada bir nechta ochiq so'rov.
        await order(10, 'waiting');
        ids.dupOld = await approval({ order: 10, status: 'pending' });
        ids.dupNew = await approval({
          order: 10,
          status: 'pending',
          createdAt: new Date('2026-11-02T10:00:00Z'),
        });

        // Tegilmaydi: yakunlangan / o'chirilgan qatorlar.
        ids.rejected = await approval({ order: 1, status: 'rejected' });
        ids.approvedSold = await approval({ order: 1, status: 'approved' });
        ids.deletedPending = await approval({
          order: 1,
          status: 'pending',
          isDeleted: true,
        });
      });

      let before: Record<string, Row>;
      let after: Record<string, Row>;

      it('migratsiya o‘tadi', async () => {
        before = await rows(false);
        await run('up');
        after = await rows();
      });

      it('⭐ buyurtmasi «kutilmoqda» bo‘lmagan pending → void (sotilgan, o‘chirilgan, yo‘q)', () => {
        for (const key of [
          'soldPending',
          'deletedOrderPending',
          'missingOrderPending',
        ]) {
          expect(after[ids[key]]).toMatchObject({
            status: 'void',
            closed_reason:
              "Buyurtma endi «kutilmoqda» holatida emas — eski so'rov yopildi",
            closed_at: expect.any(Date),
          });
        }
      });

      it('⭐ C holatidagi approved → pending: qaror maydonlari tozalanadi, createdAt yangilanadi', () => {
        for (const key of [
          'cState',
          'cStateCancelFresh',
          'cStateSameStatusRow',
          'newerC',
        ]) {
          const row = after[ids[key]];
          expect(row).toMatchObject({
            status: 'pending',
            decided_by_user_id: null,
            decided_at: null,
            decision_comment: null,
            auto_approved: false,
            reminder_sent_at: null,
            closed_reason: null,
          });
          expect(row.createdAt.getTime()).toBeGreaterThan(
            before[ids[key]].createdAt.getTime(),
          );
        }
      });

      it('⭐ C holati, lekin so‘rovdan keyin buyurtma holati o‘zgargan — qayta ochilmaydi, void (qaror maydonlari, createdAt saqlanadi)', () => {
        for (const key of ['cStateCancel', 'cStateRedispatched']) {
          expect(after[ids[key]]).toMatchObject({
            status: 'void',
            closed_reason:
              "So'rov ochilgandan keyin buyurtma holati o'zgargan — eski tasdiq bajarilmagan edi, qayta ochilmadi",
            closed_at: expect.any(Date),
            decided_by_user_id: before[ids[key]].decided_by_user_id,
            createdAt: before[ids[key]].createdAt,
          });
        }
      });

      it('⭐ shu buyurtmada ochiq yoki yangiroq C so‘rov bo‘lsa — C void, ochig‘i qoladi', () => {
        for (const key of ['cStateWithPending', 'olderC']) {
          expect(after[ids[key]]).toMatchObject({
            status: 'void',
            closed_reason:
              "Yangi so'rov bilan almashtirildi — eski tasdiq bajarilmagan edi",
          });
        }
        expect(after[ids.pendingNextToC].status).toBe('pending');
      });

      it('⭐ bir nechta ochiq so‘rov — eng yangisi qoladi', () => {
        expect(after[ids.dupOld]).toMatchObject({
          status: 'void',
          closed_reason:
            "Yangi so'rov bilan almashtirildi — eski so'rov yopildi",
        });
        expect(after[ids.dupNew].status).toBe('pending');
      });

      it('⭐ boshqa qatorlar o‘zgarmaydi', () => {
        for (const key of [
          'livePending',
          'executedThenRolledBack',
          'financeLegs',
          'rejected',
          'approvedSold',
          'deletedPending',
        ]) {
          expect(after[ids[key]]).toEqual({
            ...before[ids[key]],
            closed_reason: null,
            closed_at: null,
          });
        }
      });

      it('⭐ partial unique indeks: bitta buyurtmada ikkinchi ochiq so‘rov — 23505; o‘chirilgan qatorga ta’sir qilmaydi', async () => {
        await expect(
          approval({ order: 3, status: 'pending' }),
        ).rejects.toMatchObject({
          driverError: expect.objectContaining({
            code: '23505',
            constraint: 'UQ_ORDER_EXTRA_COST_APPROVAL_PENDING',
          }),
        });
        await expect(
          approval({ order: 3, status: 'pending', isDeleted: true }),
        ).resolves.toEqual(expect.any(String));
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
              AND column_name IN ('closed_reason', 'closed_at', 'closed_by_user_id')`,
        );
        expect(columns).toEqual([]);
        const indexes: unknown[] = await db.query(
          `SELECT 1 FROM pg_indexes
            WHERE indexname = 'UQ_ORDER_EXTRA_COST_APPROVAL_PENDING'`,
        );
        expect(indexes).toEqual([]);
      });
    });
  },
);
