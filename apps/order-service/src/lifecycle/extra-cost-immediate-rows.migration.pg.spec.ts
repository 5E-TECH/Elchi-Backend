import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { ExtraCostApprovalVoidReversed1716000000206 } from '../../../../migrations/1716000000206-ExtraCostApprovalVoidReversed';
import { ExtraCostAutoApproveFrom1716000000208 } from '../../../../migrations/1716000000208-ExtraCostAutoApproveFrom';
import { ExtraCostImmediateRows1716000000210 } from '../../../../migrations/1716000000210-ExtraCostImmediateRows';

/**
 * GykuOz8f — migratsiya 210 haqiqiy Postgres'da (BOT_PG_TEST_URI — faqat
 * lokal baza). O'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • `immediate` ustuni (sukut false) va kuryer / filial indekslari;
 *  • eski ma'lumot: `extra_cost > 0`, o'chirilmagan, `approved` so'rovi yo'q
 *    buyurtmaga bitta `immediate` qator — kim / qachon / qaysi amal oxirgi
 *    «kutilmoqda» → sotildi / to'landi / qisman / bekor o'tishidan; filial —
 *    `branch_schema.branch_users` (jadval yo'q — NULL); mos o'tish yo'q yoki
 *    yozgan id raqam emas — o'tkazib yuboriladi (logda soni);
 *  • qayta yurgizish hech narsani o'zgartirmaydi; down() — `immediate`
 *    qatorlar, indekslar va ustun olib tashlanadi;
 *  • jadvallar yo'q — xatosiz.
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();

type ApprovalRow = {
  id: string;
  order_id: string;
  market_id: string;
  requested_by_user_id: string;
  requested_by_role: string | null;
  requester_branch_id: string | null;
  action: string;
  amount: string;
  proof_file_keys: unknown;
  operation_payload: unknown;
  status: string;
  immediate: boolean;
  auto_approved: boolean;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const T = (minute: number) => new Date(Date.UTC(2026, 9, 20, 10, minute, 0));

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 210 — tasdiqsiz yozilgan xarajat qatorlari (haqiqiy Postgres)',
  () => {
    jest.setTimeout(30_000);
    const dbName = `spec_xc_imm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new ExtraCostImmediateRows1716000000210();
    let log: jest.SpyInstance;

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

    const logged = () =>
      log.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .filter((line: string) => line.startsWith('[migration 210]'));

    const hasColumn = async () =>
      (
        await db.query<unknown[]>(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'order_schema'
              AND table_name = 'order_extra_cost_approvals'
              AND column_name = 'immediate'`,
        )
      ).length > 0;

    const indexes = async () =>
      (
        await db.query<Array<{ indexname: string }>>(
          `SELECT indexname FROM pg_indexes
            WHERE indexname IN ('IDX_EXTRA_COST_REQUESTER_CREATED', 'IDX_EXTRA_COST_BRANCH_CREATED')
            ORDER BY indexname`,
        )
      ).map((row) => row.indexname);

    const approvals = async (): Promise<ApprovalRow[]> =>
      db.query(
        `SELECT id::text AS id, order_id::text AS order_id, market_id::text AS market_id,
                requested_by_user_id::text AS requested_by_user_id, requested_by_role,
                requester_branch_id::text AS requester_branch_id, action, amount::text AS amount,
                proof_file_keys, operation_payload, status, immediate, auto_approved,
                decided_by_user_id::text AS decided_by_user_id, decided_at,
                "createdAt", "updatedAt"
           FROM order_schema.order_extra_cost_approvals
          ORDER BY order_id, id`,
      );
    const immediateByOrder = async () =>
      Object.fromEntries(
        (await approvals())
          .filter((row) => row.immediate)
          .map((row) => [row.order_id, row]),
      );

    beforeAll(async () => {
      log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri!);
      url.pathname = `/${dbName}`;
      db = new DataSource({ type: 'postgres', url: url.toString() });
      await db.initialize();
    });

    afterAll(async () => {
      log?.mockRestore();
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.destroy();
      }
    });

    it('so‘rovlar jadvali yo‘q — up() va down() xatosiz, hech narsa qilmaydi', async () => {
      await db.query('CREATE SCHEMA order_schema');
      await expect(run('up')).resolves.toBeUndefined();
      await expect(run('down')).resolves.toBeUndefined();
      expect(logged()).toEqual([]);
    });

    it('buyurtmalar / kuzatuv jadvali yo‘q — ustun va indekslar qo‘shiladi, ko‘chirish yo‘q (logda)', async () => {
      const runner = db.createQueryRunner();
      try {
        await new CreateOrderExtraCostApprovals1716000000026().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
      } finally {
        await runner.release();
      }

      await run('up');

      expect(await hasColumn()).toBe(true);
      expect(await indexes()).toEqual([
        'IDX_EXTRA_COST_BRANCH_CREATED',
        'IDX_EXTRA_COST_REQUESTER_CREATED',
      ]);
      expect(logged()).toEqual([
        "[migration 210] extra-cost: orders / order_tracking jadvali yo'q — eski xarajatlar ko'chirilmadi",
      ]);

      await run('down');
      expect(await hasColumn()).toBe(false);
      expect(await indexes()).toEqual([]);
    });

    describe('eski xarajatlar (backfill)', () => {
      let existing: Record<string, string>;

      beforeAll(async () => {
        const statuses = Object.values(Order_status)
          .map((status) => `'${status}'`)
          .join(', ');
        await db.query(
          `CREATE TYPE order_schema.orders_status_enum AS ENUM (${statuses})`,
        );
        // Prod ustun turlari: extra_cost int, proof_files jsonb, kuzatuvda
        // changed_by varchar (hamkor / tizim ham yoziladi).
        await db.query(`
          CREATE TABLE order_schema.orders (
            id bigint PRIMARY KEY,
            status order_schema.orders_status_enum NOT NULL DEFAULT 'waiting',
            is_deleted boolean NOT NULL DEFAULT false,
            market_id bigint NULL,
            extra_cost int NOT NULL DEFAULT 0,
            proof_files jsonb NULL
          )`);
        await db.query(`
          CREATE TABLE order_schema.order_tracking (
            id bigserial PRIMARY KEY,
            order_id bigint NOT NULL,
            from_status order_schema.orders_status_enum,
            to_status order_schema.orders_status_enum NOT NULL,
            action varchar(64) NULL,
            changed_by varchar(64) NOT NULL,
            changed_by_role varchar(32) NOT NULL,
            note text NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )`);
        const runner = db.createQueryRunner();
        try {
          await new ExtraCostApprovalVoidReversed1716000000206().up(runner);
          await new ExtraCostAutoApproveFrom1716000000208().up(runner);
        } finally {
          await runner.release();
        }

        // [id, status, extra_cost, market_id, proof_files, is_deleted]
        const orders: Array<
          [number, string, number, number | null, string | null, boolean]
        > = [
          [1, 'sold', 5000, 501, '["proof/1.jpg", "proof/1.mp4"]', false],
          [2, 'cancelled', 7000, 501, null, false],
          [3, 'sold', 3000, 502, null, false],
          [4, 'cancelled (sent)', 2000, 502, null, false],
          [5, 'sold', 9000, 501, null, false],
          [6, 'sold', 6000, 501, null, false],
          [7, 'sold', 4000, 501, null, false],
          [8, 'sold', 4000, 501, null, false],
          // O'chirilgan buyurtma — nomzod emas.
          [9, 'sold', 4000, 501, null, true],
          // Xarajatsiz.
          [10, 'sold', 0, 501, null, false],
          [11, 'paid', 1500, 501, null, false],
          [12, 'sold', 8000, 501, null, false],
          [13, 'partly_paid', 2500, 501, '{"key": "proof/x.jpg"}', false],
          // Marketsiz (bigint NOT NULL ustun) — nomzod emas.
          [14, 'sold', 4000, null, null, false],
          // 154a400d gacha rollback extra_cost ni tozalamasdi: «kutilmoqda»
          // ga qaytgan buyurtma — nomzod emas (holat).
          [15, 'waiting', 5000, 501, null, false],
          // Sotuv «Rollback to cancelled» bilan qaytarilgan — o'tkazib yuboriladi.
          [16, 'cancelled', 3000, 501, null, false],
        ];
        for (const [
          id,
          status,
          extraCost,
          marketId,
          proofs,
          deleted,
        ] of orders) {
          await db.query(
            `INSERT INTO order_schema.orders (id, status, extra_cost, market_id, proof_files, is_deleted)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [id, status, extraCost, marketId, proofs, deleted],
          );
        }

        // [order, from, to, changed_by, role, minute, action, note]
        const tracking: Array<
          [
            number,
            string | null,
            string,
            string,
            string,
            number,
            string | null,
            string | null,
          ]
        > = [
          // Oddiy sotuv, kuryer.
          [1, 'waiting', 'sold', '301', 'courier', 1, null, null],
          // Menejer bekor qildi.
          [2, 'waiting', 'cancelled', '201', 'manager', 2, null, null],
          // Qisman sotuv — izohdan (partlySellOrder: «Order partly sold»).
          [
            3,
            'waiting',
            'sold',
            '301',
            'courier',
            3,
            null,
            'Order partly sold',
          ],
          [4, 'waiting', 'cancelled (sent)', '302', 'courier', 4, null, null],
          // Tasdiqlangan so'rovi bor — o'tkazib yuboriladi (nomzod emas).
          [5, 'waiting', 'sold', '301', 'courier', 5, null, null],
          [6, 'waiting', 'sold', '302', 'courier', 6, null, null],
          // Tizim / hamkor yozgan — o'tkazib yuboriladi.
          [7, 'waiting', 'sold', 'partner:4', 'partner', 7, null, null],
          // 8 — kuzatuv yo'q.
          [9, 'waiting', 'sold', '301', 'courier', 9, null, null],
          [10, 'waiting', 'sold', '301', 'courier', 10, null, null],
          // Superadmin sotgan — rol «courier», filial yo'q (a'zo emas).
          [11, 'waiting', 'paid', '1', 'superadmin', 11, null, null],
          // Oxirgi mos o'tish ustun: avval bekor (301), orqaga qaytarildi,
          // so'ng sotildi (302). Mos kelmaydiganlar e'tiborsiz.
          [12, 'waiting', 'cancelled', '301', 'courier', 12, null, null],
          [12, 'cancelled', 'waiting', '1', 'superadmin', 13, null, null],
          [12, 'waiting', 'sold', '302', 'courier', 14, null, null],
          [
            12,
            'waiting',
            'waiting',
            '201',
            'manager',
            15,
            'special_categories',
            null,
          ],
          [12, 'sold', 'paid', '201', 'manager', 16, null, null],
          // Qisman sotuv — action bo'yicha; isbot — massiv emas → [].
          [
            13,
            'waiting',
            'partly_paid',
            '301',
            'courier',
            17,
            'partly_sold',
            null,
          ],
          [14, 'waiting', 'sold', '301', 'courier', 18, null, null],
          [15, 'waiting', 'sold', '301', 'courier', 19, null, null],
          [
            15,
            'sold',
            'waiting',
            '1',
            'superadmin',
            20,
            null,
            'Rollback to waiting',
          ],
          [16, 'waiting', 'sold', '301', 'courier', 21, null, null],
          [
            16,
            'sold',
            'cancelled',
            '1',
            'superadmin',
            22,
            null,
            'Rollback to cancelled',
          ],
        ];
        for (const [
          order,
          from,
          to,
          by,
          role,
          minute,
          action,
          note,
        ] of tracking) {
          await db.query(
            `INSERT INTO order_schema.order_tracking
               (order_id, from_status, to_status, changed_by, changed_by_role, created_at, action, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [order, from, to, by, role, T(minute), action, note],
          );
        }

        const approval = async (order: number, status: string) => {
          const [row]: Array<{ id: string }> = await db.query(
            `INSERT INTO order_schema.order_extra_cost_approvals
               (order_id, market_id, requested_by_user_id, requested_by_role, action, amount,
                operation_payload, status)
             VALUES ($1, 501, 301, 'courier', 'sell', 9000, '{}'::jsonb, $2)
             RETURNING id::text AS id`,
            [order, status],
          );
          return row.id;
        };
        existing = {
          approved5: await approval(5, 'approved'),
          void6: await approval(6, 'void'),
          reversed6: await approval(6, 'reversed'),
        };
        log.mockClear();
      });

      it('⭐ branch_users yo‘q: 8 ta qator, 3 ta buyurtma o‘tkazib yuborildi (logda); filial NULL', async () => {
        await run('up');

        expect(logged()).toEqual([
          "[migration 210] extra-cost: tasdiqsiz yozilgan eski xarajatlar — 8 ta qator qo'shildi, 3 ta buyurtma o'tkazib yuborildi (mos kuzatuv yozuvi yo'q yoki ijro orqaga qaytarilgan)",
        ]);
        const rows = await immediateByOrder();
        expect(Object.keys(rows).sort((a, b) => Number(a) - Number(b))).toEqual(
          ['1', '2', '3', '4', '6', '11', '12', '13'],
        );
        for (const row of Object.values(rows)) {
          expect(row.requester_branch_id).toBeNull();
        }
      });

      it('⭐ qator maydonlari: kim, amal, summa, isbot, vaqt — kuzatuv yozuvidan', async () => {
        const rows = await immediateByOrder();
        expect(rows['1']).toEqual({
          id: expect.any(String),
          order_id: '1',
          market_id: '501',
          requested_by_user_id: '301',
          requested_by_role: 'courier',
          requester_branch_id: null,
          action: 'sell',
          amount: '5000.00',
          proof_file_keys: ['proof/1.jpg', 'proof/1.mp4'],
          operation_payload: { backfill: true },
          status: 'approved',
          immediate: true,
          auto_approved: false,
          decided_by_user_id: null,
          decided_at: T(1),
          createdAt: T(1),
          updatedAt: T(1),
        });
        expect(rows['2']).toMatchObject({
          requested_by_user_id: '201',
          requested_by_role: 'manager',
          action: 'cancel',
          amount: '7000.00',
          proof_file_keys: [],
        });
        expect(rows['3']).toMatchObject({ action: 'partly_sell' });
        expect(rows['4']).toMatchObject({
          action: 'cancel',
          requested_by_user_id: '302',
          market_id: '502',
        });
        // Faqat void / reversed so'rovi bor buyurtma ham nomzod.
        expect(rows['6']).toMatchObject({ action: 'sell', amount: '6000.00' });
        expect(rows['11']).toMatchObject({
          requested_by_user_id: '1',
          requested_by_role: 'courier',
          action: 'sell',
        });
        expect(rows['12']).toMatchObject({
          requested_by_user_id: '302',
          action: 'sell',
          createdAt: T(14),
          decided_at: T(14),
        });
        expect(rows['13']).toMatchObject({
          action: 'partly_sell',
          proof_file_keys: [],
        });
      });

      it('mavjud so‘rovlar o‘zgarmaydi (`immediate` false); yangi qator — sukut false', async () => {
        const all = await approvals();
        for (const id of Object.values(existing)) {
          expect(all.find((row) => row.id === id)).toMatchObject({
            immediate: false,
          });
        }
        expect(all.find((row) => row.id === existing.approved5)!.status).toBe(
          'approved',
        );
        const [fresh]: Array<{ immediate: boolean }> = await db.query(
          `INSERT INTO order_schema.order_extra_cost_approvals
             (order_id, market_id, requested_by_user_id, action, amount, operation_payload, status)
           VALUES (8, 501, 301, 'sell', 4000, '{}'::jsonb, 'pending')
           RETURNING immediate`,
        );
        expect(fresh).toEqual({ immediate: false });
        await db.query(
          `DELETE FROM order_schema.order_extra_cost_approvals WHERE order_id = 8`,
        );
      });

      it('⭐ qayta yurgizish hech narsani o‘zgartirmaydi', async () => {
        const once = await approvals();
        log.mockClear();

        await run('up');

        expect(await approvals()).toEqual(once);
        expect(logged()).toEqual([
          "[migration 210] extra-cost: tasdiqsiz yozilgan eski xarajatlar — 0 ta qator qo'shildi, 3 ta buyurtma o'tkazib yuborildi (mos kuzatuv yozuvi yo'q yoki ijro orqaga qaytarilgan)",
        ]);
      });

      it('⭐ down(): faqat `immediate` qatorlar o‘chadi, indekslar va ustun olib tashlanadi', async () => {
        await run('down');

        expect(await hasColumn()).toBe(false);
        expect(await indexes()).toEqual([]);
        const left: Array<{ id: string }> = await db.query(
          `SELECT id::text AS id FROM order_schema.order_extra_cost_approvals ORDER BY id`,
        );
        expect(left.map((row) => row.id).sort()).toEqual(
          Object.values(existing).sort(),
        );
      });

      it('⭐ branch_users bor: filial — yozgan xodimning HOZIRGI faol a‘zoligi', async () => {
        await db.query('CREATE SCHEMA branch_schema');
        await db.query(`
          CREATE TABLE branch_schema.branch_users (
            id bigserial PRIMARY KEY,
            "createdAt" timestamptz NOT NULL DEFAULT now(),
            "updatedAt" timestamptz NOT NULL DEFAULT now(),
            is_deleted boolean NOT NULL DEFAULT false,
            branch_id bigint NOT NULL,
            user_id bigint NOT NULL
          )`);
        // [user, branch, deleted, minute]
        for (const [user, branch, deleted, minute] of [
          [301, 66, true, 50],
          [301, 77, false, 1],
          [201, 55, false, 1],
          [201, 77, false, 30],
          [302, 88, false, 1],
        ] as Array<[number, number, boolean, number]>) {
          await db.query(
            `INSERT INTO branch_schema.branch_users (user_id, branch_id, is_deleted, "createdAt")
             VALUES ($1, $2, $3, $4)`,
            [user, branch, deleted, T(minute)],
          );
        }
        log.mockClear();

        await run('up');

        const rows = await immediateByOrder();
        expect(Object.keys(rows)).toHaveLength(8);
        // O'chirilgan a'zolik (66) emas — faol 77.
        expect(rows['1'].requester_branch_id).toBe('77');
        // Bir nechta faol a'zolik — eng yangisi.
        expect(rows['2'].requester_branch_id).toBe('77');
        expect(rows['4'].requester_branch_id).toBe('88');
        expect(rows['12'].requester_branch_id).toBe('88');
        // Superadmin — a'zo emas.
        expect(rows['11'].requester_branch_id).toBeNull();
        expect(await indexes()).toEqual([
          'IDX_EXTRA_COST_BRANCH_CREATED',
          'IDX_EXTRA_COST_REQUESTER_CREATED',
        ]);
        expect(logged()).toEqual([
          "[migration 210] extra-cost: tasdiqsiz yozilgan eski xarajatlar — 8 ta qator qo'shildi, 3 ta buyurtma o'tkazib yuborildi (mos kuzatuv yozuvi yo'q yoki ijro orqaga qaytarilgan)",
        ]);
      });
    });
  },
);
