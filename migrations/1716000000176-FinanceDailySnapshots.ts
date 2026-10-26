import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * qzjTMWPb — moliya kunlik balans snapshot'i (O'QISH MODELI).
 *
 * `finance_schema.finance_cashbox_daily` — kassa × Toshkent kuni: kun boshi /
 * kun oxiri qoldig'i (`cashbox_history.balance_after` dan), kunlik kirim /
 * chiqim va soni. Faqat kun oxiri qoldig'i ≠ 0 YOKI shu kuni harakati bo'lgan
 * kassalar yoziladi (nol qoldiqli jim kassa = qator yo'q = 0).
 *
 * `finance_schema.finance_daily_snapshots` — kompaniya holati × kun: asosiy
 * kassa, filial / kuryer / market kassalari yig'indisi, daftar qoldig'i va
 * (faqat `source = 'live'` kunlarda) zanjirdagi / kargodagi qarz va umumiy
 * holat. Qator — shu kun to'liq qayta ishlanganining belgisi (job idempotent).
 *
 * ⚠️ PUL HARAKATI EMAS: kassa balanslari, `cashbox_history` va P&L daftariga
 * TEGMAYDI — faqat ulardan o'qib yoziladigan nusxa. Ikkala jadvalni istalgan
 * payt TRUNCATE qilish xavfsiz: finance-service job'i ularni tarixdan qayta
 * quradi (backfill — FinanceDailySnapshotService izohi). Qayta yurgizish
 * xavfsiz (IF NOT EXISTS).
 */
export class FinanceDailySnapshots1716000000176 implements MigrationInterface {
  name = 'FinanceDailySnapshots1716000000176';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."finance_cashbox_daily" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "snapshot_date" DATE NOT NULL,
        "cashbox_id" BIGINT NOT NULL,
        "cashbox_type" VARCHAR(16) NOT NULL,
        "user_id" BIGINT NOT NULL,
        "opening_balance" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "closing_balance" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "closing_cash" NUMERIC(20,2) NULL,
        "closing_card" NUMERIC(20,2) NULL,
        "income" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "expense" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "income_count" INTEGER NOT NULL DEFAULT 0,
        "expense_count" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "PK_finance_cashbox_daily_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FINANCE_CASHBOX_DAILY_DATE_CASHBOX"
        ON "finance_schema"."finance_cashbox_daily" ("snapshot_date", "cashbox_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FINANCE_CASHBOX_DAILY_CASHBOX_DATE"
        ON "finance_schema"."finance_cashbox_daily" ("cashbox_id", "snapshot_date")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FINANCE_CASHBOX_DAILY_TYPE_DATE"
        ON "finance_schema"."finance_cashbox_daily" ("cashbox_type", "snapshot_date")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."finance_daily_snapshots" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "snapshot_date" DATE NOT NULL,
        "source" VARCHAR(16) NOT NULL,
        "captured_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "main_balance" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "main_balance_cash" NUMERIC(20,2) NULL,
        "main_balance_card" NUMERIC(20,2) NULL,
        "branch_cashbox_total" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "courier_cashbox_total" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "market_cashbox_total" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "market_payable_total" NUMERIC(20,2) NOT NULL DEFAULT 0,
        "chain_receivable" NUMERIC(20,2) NULL,
        "provider_receivable" NUMERIC(20,2) NULL,
        "current_situation" NUMERIC(20,2) NULL,
        "ledger_balance" NUMERIC(20,2) NULL,
        "cashbox_count" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "PK_finance_daily_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_FINANCE_DAILY_SNAPSHOT_SOURCE"
          CHECK ("source" IN ('live', 'backfill'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FINANCE_DAILY_SNAPSHOT_DATE"
        ON "finance_schema"."finance_daily_snapshots" ("snapshot_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."finance_daily_snapshots"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."finance_cashbox_daily"`,
    );
  }
}
