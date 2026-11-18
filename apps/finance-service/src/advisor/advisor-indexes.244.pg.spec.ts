import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CashboxHistoryZeroBalanceIndex1716000000244 } from '../../../../migrations/1716000000244-CashboxHistoryZeroBalanceIndex';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';

/**
 * Migratsiya 244 (#702 perf): qisman indeks `cashbox_history (cashbox_id,
 * createdAt, id) WHERE balance_after <= 0 AND is_deleted = false`.
 * Haqiqiy Postgres, o'z vaqtinchalik bazasi (`FINANCE_PG_TEST_URI` — faqat
 * ulanish): idempotent up, down, lock_timeout va `zr` lateral rejasi.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  'Migratsiya 244 — cashbox_history (cashbox_id, createdAt, id) WHERE balance_after <= 0',
  () => {
    const dbName = `spec_adv244_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    /** Entity @Index (synchronize) ta'rifi — migratsiya bilan bir xil bo'lishi kerak. */
    let entityDef: string | null = null;
    const migration = new CashboxHistoryZeroBalanceIndex1716000000244();
    const run = async (dir: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        await migration[dir](runner);
      } finally {
        await runner.release();
      }
    };
    const definition = async () =>
      (
        await db.query<Array<{ def: string }>>(
          `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'IDX_CASHBOX_HISTORY_ZERO_BAL'`,
        )
      )[0]?.def ?? null;

    beforeAll(async () => {
      const url = new URL(pgUri!);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('FINANCE_PG_TEST_URI faqat lokal bo‘lishi kerak');
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'finance_schema',
        entities: [Cashbox, CashboxHistory],
        synchronize: false,
      });
      await db.initialize();
      await db.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
      await db.synchronize();
      // synchronize entity @Index ni yaratadi — migratsiyani toza holatdan sinash.
      entityDef = await definition();
      await db.query(
        `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_ZERO_BAL"`,
      );
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('up idempotent, qisman (WHERE balance_after <= 0 AND NOT is_deleted); zr lateral shu indeksdan', async () => {
      await run('up');
      await run('up');
      const def = await definition();
      expect(def).toContain('(cashbox_id, "createdAt", id)');
      expect(def).toContain(
        'WHERE ((balance_after <= (0)::numeric) AND (is_deleted = false))',
      );
      // Entity @Index (synchronize) bilan farqsiz.
      expect(def).toBe(entityDef);
      await db.query('SET enable_seqscan = off');
      try {
        const plan = (
          await db.query<Array<{ 'QUERY PLAN': string }>>(
            `EXPLAIN SELECT z."createdAt", z."id" FROM "finance_schema"."cashbox_history" z
            WHERE z."cashbox_id" = 7 AND z."is_deleted" = false
              AND z."balance_after" <= 0
            ORDER BY z."createdAt" DESC, z."id" DESC LIMIT 1`,
          )
        )
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        expect(plan).toContain('IDX_CASHBOX_HISTORY_ZERO_BAL');
      } finally {
        await db.query('RESET enable_seqscan');
      }
    });

    it('lock_timeout 5 s: ochiq yozuv tranzaksiyasi bo‘lsa — yiqiladi (uzoq kutmaydi); down → up', async () => {
      await run('down');
      expect(await definition()).toBeNull();
      const writer = db.createQueryRunner();
      await writer.connect();
      await writer.startTransaction();
      const runner = db.createQueryRunner();
      try {
        await writer.query(
          'LOCK TABLE "finance_schema"."cashbox_history" IN ROW EXCLUSIVE MODE',
        );
        await runner.startTransaction();
        const t0 = Date.now();
        await expect(migration.up(runner)).rejects.toThrow(/lock timeout/);
        expect(Date.now() - t0).toBeLessThan(9000);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
        await writer.rollbackTransaction();
        await writer.release();
      }
      await run('up');
      expect(await definition()).not.toBeNull();
    }, 30_000);
  },
);
