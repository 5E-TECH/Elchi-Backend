import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { SettlementMarketPaidByBranch1716000000246 } from '../../../../migrations/1716000000246-SettlementMarketPaidByBranch';

/**
 * 63HO6cBU (PR-C) — migratsiya 246: faqat qo'shimcha ustunlar (nullable
 * `_at/_by`, `_amount` NOT NULL DEFAULT 0), (filial, market) qoldiq jadvali
 * va qisman indeks, backfill yo'q; qayta up() xatosiz; down() → toza; qayta
 * down() xatosiz. Haqiqiy Postgres (`ORDER_SETTLEMENT_PG_TEST_URI`),
 * o'z vaqtinchalik bazasi (`order_schema` ga qattiq bog'langan).
 */
const pgUri = process.env.ORDER_SETTLEMENT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  '63HO6cBU migratsiya 246 — order_settlement.market_paid_by_branch_*',
  () => {
    const dbName = `spec_m246_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new SettlementMarketPaidByBranch1716000000246();

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
    const columns = async () =>
      (
        await db.query(
          `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'order_schema' AND table_name = 'order_settlement'
            AND column_name LIKE 'market_paid_by_branch_%' ORDER BY 1`,
        )
      ).map((r: { column_name: string; is_nullable: string }) => [
        r.column_name,
        r.is_nullable,
      ]);
    const hasIndex = async () =>
      (
        await db.query(
          `SELECT 1 FROM pg_indexes WHERE schemaname = 'order_schema'
            AND indexname = 'IDX_order_settlement_branch_market_open'`,
        )
      ).length === 1;

    const hasCarryTable = async () =>
      (
        await db.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'order_schema'
            AND table_name = 'order_settlement_branch_market_carry'`,
        )
      ).length === 1;

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(pgUri as string);
      url.pathname = `/${dbName}`;
      db = new DataSource({ type: 'postgres', url: url.toString() });
      await db.initialize();
      await db.query('CREATE SCHEMA "order_schema"');
      await db.query(`CREATE TYPE "order_schema"."order_settlement_status_enum"
      AS ENUM ('pending', 'courier_settled', 'branch_settled', 'market_settled')`);
      await db.query(`CREATE TABLE "order_schema"."order_settlement" (
      "id" BIGSERIAL PRIMARY KEY,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "is_deleted" boolean NOT NULL DEFAULT false,
      "order_id" bigint NOT NULL,
      "branch_id" bigint, "market_id" bigint,
      "market_amount" numeric(14,2) NOT NULL DEFAULT 0,
      "status" "order_schema"."order_settlement_status_enum" NOT NULL DEFAULT 'pending'
    )`);
      await db.query(`INSERT INTO "order_schema"."order_settlement"
      (order_id, branch_id, market_id, market_amount, status)
      VALUES (1, 15, 201, 80000, 'courier_settled')`);
      // Migratsiya 048 (konvertatsiya skripti shu jadvalga yozadi).
      await db.query(`CREATE TABLE "order_schema"."order_settlement_carry" (
      "id" BIGSERIAL PRIMARY KEY,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "is_deleted" boolean NOT NULL DEFAULT false,
      "level" varchar(32) NOT NULL,
      "party_id" bigint NOT NULL,
      "branch_id" bigint,
      "amount" numeric(14,2) NOT NULL DEFAULT 0
    )`);
      await db.query(`CREATE UNIQUE INDEX "UQ_order_settlement_carry_level_party"
      ON "order_schema"."order_settlement_carry" ("level", "party_id")`);
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('up(): ustunlar + qoldiq jadvali + indeks, backfill yo`q; qayta up() xatosiz', async () => {
      await run('up');
      await run('up');
      expect(await columns()).toEqual([
        ['market_paid_by_branch_amount', 'NO'],
        ['market_paid_by_branch_at', 'YES'],
        ['market_paid_by_branch_by', 'YES'],
      ]);
      expect(await hasIndex()).toBe(true);
      expect(await hasCarryTable()).toBe(true);
      const [row] = await db.query(
        `SELECT market_paid_by_branch_at, market_paid_by_branch_by,
                market_paid_by_branch_amount::float AS paid, market_amount::float AS amount
         FROM "order_schema"."order_settlement"`,
      );
      expect(row).toEqual({
        market_paid_by_branch_at: null,
        market_paid_by_branch_by: null,
        paid: 0,
        amount: 80000,
      });
      // (filial, market) bo'yicha bitta qoldiq qatori.
      await db.query(
        `INSERT INTO "order_schema"."order_settlement_branch_market_carry" (branch_id, market_id, amount)
         VALUES (15, 201, 0)`,
      );
      await expect(
        db.query(
          `INSERT INTO "order_schema"."order_settlement_branch_market_carry" (branch_id, market_id, amount)
           VALUES (15, 201, 0)`,
        ),
      ).rejects.toThrow();
    });

    it('⭐ C2: filial → market to`lov holati bor — down() RAD (konvertatsiyasiz); konvertatsiya skripti qoldiqlarga o`tkazadi, keyin down() o`tadi', async () => {
      await db.query(`UPDATE "order_schema"."order_settlement"
        SET market_paid_by_branch_amount = 30000 WHERE order_id = 1`);
      await db.query(`INSERT INTO "order_schema"."order_settlement"
        (order_id, branch_id, market_id, market_amount, status, market_paid_by_branch_amount)
        VALUES (2, 16, 201, 9000, 'branch_settled', 5000),
               (3, 16, 201, 7000, 'market_settled', 7000)`);
      await db.query(
        `DELETE FROM "order_schema"."order_settlement_branch_market_carry"`,
      );
      await db.query(`INSERT INTO "order_schema"."order_settlement_branch_market_carry"
        (branch_id, market_id, amount) VALUES (15, 201, 500)`);
      await expect(run('down')).rejects.toThrow(/rad etildi/);
      expect(await columns()).toHaveLength(3);

      await db.query(
        readFileSync(
          join(
            __dirname,
            '../../../../scripts/order/convert-246-before-down.sql',
          ),
          'utf8',
        ),
      );
      const carries = await db.query(
        `SELECT level, party_id::text AS party, amount::float AS amount
           FROM "order_schema"."order_settlement_carry" ORDER BY level, party_id`,
      );
      // Filial 15: COURIER_SETTLED qism 30 000 + (15, 201) qoldig'i 500;
      // filial 16 — BRANCH_SETTLED (HQ'ga to'lab bo'lgan) — yo'q.
      // Market 201: 30 000 + 5 000 (BRANCH_SETTLED) + 500; MARKET_SETTLED — yo'q.
      expect(carries).toEqual([
        { level: 'branch_to_hq', party: '15', amount: 30_500 },
        { level: 'hq_to_market', party: '201', amount: 35_500 },
      ]);
      const [{ left }] = await db.query(
        `SELECT count(*)::int AS left FROM "order_schema"."order_settlement"
          WHERE market_paid_by_branch_amount <> 0 OR market_paid_by_branch_at IS NOT NULL`,
      );
      expect(left).toBe(0);
      await db.query(
        `DELETE FROM "order_schema"."order_settlement" WHERE order_id IN (2, 3)`,
      );
    });

    it('down(): ustunlar, jadval va indeks olib tashlanadi; qayta down() xatosiz; ma`lumot saqlanadi', async () => {
      await run('down');
      await run('down');
      expect(await columns()).toEqual([]);
      expect(await hasIndex()).toBe(false);
      expect(await hasCarryTable()).toBe(false);
      const [{ n }] = await db.query(
        `SELECT count(*)::int AS n FROM "order_schema"."order_settlement"`,
      );
      expect(n).toBe(1);
    });
  },
);
