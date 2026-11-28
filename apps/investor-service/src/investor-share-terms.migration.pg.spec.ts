import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InvestorShareTerms1716000000256 } from '../../../migrations/1716000000256-InvestorShareTerms';
import { InvestorShareTerm } from './entities/investor-share-term.entity';

/**
 * Migratsiya 256 haqiqiy Postgres'da (`investor_schema` ga qattiq bog'langan —
 * spec o'z vaqtinchalik bazasini yaratadi va o'chiradi):
 *  • «Ulush (%)» bor faol investorga bitta ochiq shart: boshi — birinchi
 *    investitsiya sanasi (Toshkent), investitsiya yo'q — yaratilgan kun;
 *  • ulushsiz va o'chirilgan investorga — shart yo'q;
 *  • qayta yurgizish — takror qator yo'q;
 *  • entity ↔ jadval mos (`date` ustunlari `YYYY-MM-DD` satr), bitta ochiq
 *    shart qoidasi (qism unikal indeks);
 *  • down() — jadval va ustun o'chiriladi.
 */
const pgUri =
  process.env.INVESTOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('migratsiya 256 — investor ulush shartlari', () => {
  const dbName = `spec_m256_${randomUUID().replace(/-/g, '').slice(0, 10)}_test`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new InvestorShareTerms1716000000256();

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

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'investor_schema',
      entities: [InvestorShareTerm],
      synchronize: false,
    });
    await db.initialize();
    // Baseline (1713400000000) + 1715900000000 + 1716000000209 dagi shakl.
    await db.query(`CREATE SCHEMA "investor_schema"`);
    await db.query(`
      CREATE TABLE "investor_schema"."investors" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "user_id" bigint NOT NULL,
        "name" varchar NOT NULL,
        "phone_number" varchar NOT NULL,
        "share_percent" NUMERIC(5,2)
      )
    `);
    await db.query(`
      CREATE TABLE "investor_schema"."investments" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "investor_id" bigint NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "invested_at" TIMESTAMPTZ NOT NULL
      )
    `);
    await db.query(`
      INSERT INTO "investor_schema"."investors"
        ("id", "createdAt", "is_deleted", "user_id", "name", "phone_number", "share_percent")
      VALUES
        (1, '2026-11-20T10:00:00Z', false, 25, 'A', '+998900000001', 10),
        (2, '2026-11-20T20:00:00Z', false, 26, 'B', '+998900000002', 5),
        (3, '2026-11-20T10:00:00Z', false, 27, 'C', '+998900000003', NULL),
        (4, '2026-11-20T10:00:00Z', true, 28, 'D', '+998900000004', 7)
    `);
    await db.query(`
      INSERT INTO "investor_schema"."investments"
        ("investor_id", "amount", "invested_at", "is_deleted")
      VALUES
        (1, 1000, '2026-11-05T06:00:00Z', false),
        -- 31-oktabr 19:30 UTC = 1-noyabr 00:30 Toshkent
        (1, 2000, '2026-10-31T19:30:00Z', false),
        -- o'chirilgan investitsiya hisobga kirmaydi
        (1, 3000, '2026-10-01T06:00:00Z', true)
    `);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin?.destroy();
  });

  const terms = () =>
    db.query(
      `SELECT "investor_id"::text AS investor_id, "share_percent"::float AS share,
              "profit_basis", to_char("effective_from", 'YYYY-MM-DD') AS from_day,
              "effective_to"
       FROM "investor_schema"."investor_share_terms" ORDER BY "investor_id"`,
    );

  it('⭐ backfill: birinchi investitsiya (Toshkent) yoki yaratilgan kun', async () => {
    await run('up');
    expect(await terms()).toEqual([
      {
        investor_id: '1',
        share: 10,
        profit_basis: 'net',
        from_day: '2026-11-01',
        effective_to: null,
      },
      {
        investor_id: '2',
        share: 5,
        profit_basis: 'net',
        from_day: '2026-11-21',
        effective_to: null,
      },
    ]);
    const [basis] = await db.query(
      `SELECT "profit_basis" FROM "investor_schema"."investors" WHERE "id" = 3`,
    );
    expect(basis.profit_basis).toBe('net');
  });

  it('qayta yurgizish — takror qator yo`q', async () => {
    await run('up');
    expect(await terms()).toHaveLength(2);
  });

  it('entity ↔ jadval: date satr, bitta ochiq shart qoidasi', async () => {
    const repo = db.getRepository(InvestorShareTerm);
    const rows = await repo.find({ where: { investor_id: '1' } });
    expect(rows[0]).toMatchObject({
      effective_from: '2026-11-01',
      effective_to: null,
      share_percent: 10,
    });

    await expect(
      repo.save(
        repo.create({
          investor_id: '1',
          share_percent: 20,
          profit_basis: 'gross',
          effective_from: '2026-11-25',
          effective_to: null,
        }),
      ),
    ).rejects.toThrow(/UQ_INVESTOR_SHARE_TERMS_OPEN/);

    await repo.update({ id: rows[0].id }, { effective_to: '2026-11-25' });
    const saved = await repo.save(
      repo.create({
        investor_id: '1',
        share_percent: 20,
        profit_basis: 'gross',
        effective_from: '2026-11-25',
        effective_to: null,
      }),
    );
    expect(saved.id).toBeDefined();

    await expect(
      db.query(
        `UPDATE "investor_schema"."investors" SET "profit_basis" = 'revenue' WHERE "id" = 1`,
      ),
    ).rejects.toThrow(/CHK_investors_profit_basis/);
  });

  it('down() — jadval va ustun o`chiriladi', async () => {
    await run('down');
    const [table] = await db.query(
      `SELECT to_regclass('"investor_schema"."investor_share_terms"') AS t`,
    );
    expect(table.t).toBeNull();
    const columns = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'investor_schema' AND table_name = 'investors'
         AND column_name = 'profit_basis'`,
    );
    expect(columns).toHaveLength(0);
  });
});
