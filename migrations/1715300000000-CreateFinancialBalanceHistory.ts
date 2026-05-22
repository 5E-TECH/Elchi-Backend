import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.C — company-wide financial balance ledger.
 *
 * Append-only P&L ledger distinct from cashbox_history. Each row records a
 * financially-significant event (order profit, manual income/expense, salary,
 * correction, bills) with the running balance snapshotted before and after,
 * so the current financial position is the latest row's balance_after.
 *
 * Money columns are double precision to match the rest of finance_schema.
 */
export class CreateFinancialBalanceHistory1715300000000 implements MigrationInterface {
  name = 'CreateFinancialBalanceHistory1715300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'financial_balance_history_source_type_enum'
            AND n.nspname = 'finance_schema'
        ) THEN
          CREATE TYPE "finance_schema"."financial_balance_history_source_type_enum"
            AS ENUM ('sell_profit', 'manual_income', 'manual_expense', 'salary', 'correction', 'bills');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."financial_balance_history" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "amount" DOUBLE PRECISION NOT NULL,
        "balance_before" DOUBLE PRECISION NOT NULL,
        "balance_after" DOUBLE PRECISION NOT NULL,
        "source_type" "finance_schema"."financial_balance_history_source_type_enum" NOT NULL,
        "order_id" BIGINT,
        "related_user_id" BIGINT,
        "comment" TEXT,
        "created_by" BIGINT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FBH_CREATED_AT"
      ON "finance_schema"."financial_balance_history" ("createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FBH_SOURCE_TYPE"
      ON "finance_schema"."financial_balance_history" ("source_type");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FBH_ORDER"
      ON "finance_schema"."financial_balance_history" ("order_id");
    `);

    // Idempotency for order-sourced ledger entries: at most one row per
    // (source_type, order_id) so a re-delivered SELL_PROFIT/CORRECTION event
    // does not double-count. Partial: only when order_id is present.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FBH_SOURCE_ORDER"
      ON "finance_schema"."financial_balance_history" ("source_type", "order_id")
      WHERE "order_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."financial_balance_history" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."financial_balance_history_source_type_enum";`,
    );
  }
}
