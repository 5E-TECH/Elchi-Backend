import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CashboxHistoryCashboxCreatedIndex1716000000243 } from '../../../../migrations/1716000000243-CashboxHistoryCashboxCreatedIndex';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';

/**
 * Migratsiya 243 (#702 review): `cashbox_history (cashbox_id, createdAt, id)`.
 * Haqiqiy Postgres, o'z vaqtinchalik bazasi (`FINANCE_PG_TEST_URI` — faqat
 * ulanish): idempotent up, down, lock_timeout va `rs` lateral rejasi.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  'Migratsiya 243 — cashbox_history (cashbox_id, createdAt, id)',
  () => {
    const dbName = `spec_adv243_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new CashboxHistoryCashboxCreatedIndex1716000000243();
    const run = async (dir: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        await migration[dir](runner);
      } finally {
        await runner.release();
      }
    };
    const exists = async () =>
      (
        await db.query<Array<{ n: string }>>(
          `SELECT COUNT(*) AS n FROM pg_indexes WHERE indexname = 'IDX_CASHBOX_HISTORY_CASHBOX_CREATED'`,
        )
      )[0].n === '1';

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
      await db.query(
        `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_CASHBOX_CREATED"`,
      );
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('up idempotent; rs lateral (bitta qator taqqoslash) indeksdan foydalanadi', async () => {
      await run('up');
      await run('up');
      expect(await exists()).toBe(true);
      await db.query('SET enable_seqscan = off');
      try {
        const plan = (
          await db.query<Array<{ 'QUERY PLAN': string }>>(
            `EXPLAIN SELECT s."id" FROM "finance_schema"."cashbox_history" s
            WHERE s."cashbox_id" = 7 AND s."is_deleted" = false
              AND (s."createdAt", s."id") >
                  (COALESCE(NULL::timestamptz, '-infinity'::timestamptz), COALESCE(NULL::bigint, 0))
            ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1`,
          )
        )
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        expect(plan).toContain('IDX_CASHBOX_HISTORY_CASHBOX_CREATED');
      } finally {
        await db.query('RESET enable_seqscan');
      }
    });

    it('lock_timeout 5 s: ochiq yozuv tranzaksiyasi bo‘lsa — yiqiladi (uzoq kutmaydi); down → up', async () => {
      await run('down');
      expect(await exists()).toBe(false);
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
      expect(await exists()).toBe(true);
    }, 30_000);
  },
);
