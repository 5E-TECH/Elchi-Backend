import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AiAdvisorRuleStateColumnsAndIndexes1716000000241 } from '../../../../migrations/1716000000241-AiAdvisorRuleStateColumnsAndIndexes';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift } from '../entities/shift.entity';

/**
 * Migratsiya 241 (BE-5 review round-4): eski 226 shaklidagi
 * `ai_advisor_rule_state` ga ustunlar; R3 va R1 so'rovlari uchun indekslar.
 * Haqiqiy Postgres, o'z vaqtinchalik bazasi (`FINANCE_PG_TEST_URI` — faqat
 * ulanish). Reja tekshiruvi — so'rovlar advisor-inputs dagi shakl bilan.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('Migratsiya 241 — maslahatchi ustunlari va indekslari', () => {
  const dbName = `spec_adv241_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new AiAdvisorRuleStateColumnsAndIndexes1716000000241();

  const run = async (dir: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    try {
      await migration[dir](runner);
    } finally {
      await runner.release();
    }
  };

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
      entities: [Cashbox, CashboxHistory, Shift, CashboxExpenseCategory],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    await db.synchronize();
    // ESKI 226 shakli: last_failed / failures YO'Q.
    await db.query(`
      CREATE SCHEMA IF NOT EXISTS "ai_schema";
      CREATE TABLE "ai_schema"."ai_advisor_rule_state" (
        "id" bigserial PRIMARY KEY,
        "rule_key" character varying(4) NOT NULL,
        "cursor_at" TIMESTAMP WITH TIME ZONE,
        "last_candidates" integer NOT NULL DEFAULT 0
      );
      INSERT INTO "ai_schema"."ai_advisor_rule_state" ("rule_key") VALUES ('R1');
    `);
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const indexes = () =>
    db.query<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('IDX_CASHBOX_HISTORY_ADVISOR_R3', 'IDX_SHIFT_ADVISOR_R1_OWNER_CLOSED')
        ORDER BY indexname`,
    );

  it('eski 226 jadvaliga ustunlar qo‘shiladi (mavjud qator sukut bilan); qayta yurgizish xatosiz', async () => {
    await run('up');
    await run('up');
    const [row] = await db.query<
      Array<{ last_failed: number; failures: object }>
    >(
      `SELECT last_failed, failures FROM "ai_schema"."ai_advisor_rule_state" WHERE rule_key = 'R1'`,
    );
    expect(row).toEqual({ last_failed: 0, failures: {} });
    expect((await indexes()).map((r) => r.indexname)).toEqual([
      'IDX_CASHBOX_HISTORY_ADVISOR_R3',
      'IDX_SHIFT_ADVISOR_R1_OWNER_CLOSED',
    ]);
  });

  it('R1 prior va R3 oyna so‘rovlari indeksdan foydalanadi (Seq Scan emas)', async () => {
    await run('up');
    await db.query(`SET enable_seqscan = off`);
    try {
      const r1 = (
        await db.query<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT s."id" FROM "finance_schema"."shifts" s
            WHERE s."status" = 'closed' AND s."is_deleted" = false
              AND (s."discrepancy_cash" IS NOT NULL OR s."discrepancy_card" IS NOT NULL)
              AND COALESCE(s."cashbox_user_id", 0) = 7
              AND (s."closed_at", s."id") < (now(), 1000)
            ORDER BY s."closed_at" DESC, s."id" DESC LIMIT 50`,
        )
      )
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(r1).toContain('IDX_SHIFT_ADVISOR_R1_OWNER_CLOSED');
      expect(r1).not.toMatch(/Sort/);

      const r3 = (
        await db.query<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT ABS(w."amount") FROM "finance_schema"."cashbox_history" w
            WHERE w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
              AND w."is_deleted" = false AND w."expense_category_id" = 3
              AND w."cashbox_id" = 5 AND w."id" <> 9
              AND w."createdAt" >= now() - INTERVAL '30 days' AND w."createdAt" < now()`,
        )
      )
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(r3).toContain('IDX_CASHBOX_HISTORY_ADVISOR_R3');
    } finally {
      await db.query(`RESET enable_seqscan`);
    }
  });

  it('R3 indeksi INCLUDE da id ham bor (oynadagi w.id <> h.id — index-only)', async () => {
    await run('up');
    const [{ def }] = await db.query<Array<{ def: string }>>(
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'IDX_CASHBOX_HISTORY_ADVISOR_R3'`,
    );
    expect(def).toMatch(/INCLUDE \(cashbox_id, amount, id\)/);
  });

  it('lock_timeout 5 s: cashbox_history da ochiq yozuv tranzaksiyasi bo‘lsa — DDL uzoq kutmaydi, yiqiladi', async () => {
    await run('down');
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
    expect(await indexes()).toHaveLength(2);
  }, 30_000);

  it('down — indekslar olib tashlanadi, ustunlar qoladi; qayta up ishlaydi', async () => {
    await run('down');
    expect(await indexes()).toEqual([]);
    const cols = await db.query<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'ai_schema' AND table_name = 'ai_advisor_rule_state'
          AND column_name IN ('last_failed', 'failures')`,
    );
    expect(cols).toHaveLength(2);
    await run('up');
    expect(await indexes()).toHaveLength(2);
  });
});
