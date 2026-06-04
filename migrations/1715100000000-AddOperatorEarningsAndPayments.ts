import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.B — operator commission.
 *
 * 1. identity_schema.admins gains commission_type + commission_value so an
 *    operator's per-order commission can be configured.
 * 2. finance_schema gets operator_earnings (one row per sold order, UNIQUE on
 *    order_id for idempotency) and operator_payments (payouts against the
 *    accrued balance).
 *
 * Money columns are `double precision` to match the existing cashbox columns
 * (Elchi stores money as float today — see check-cashbox-invariant.ts).
 */
export class AddOperatorEarningsAndPayments1715100000000 implements MigrationInterface {
  name = 'AddOperatorEarningsAndPayments1715100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- identity: commission config on operator users ---
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'admins_commission_type_enum'
            AND n.nspname = 'identity_schema'
        ) THEN
          CREATE TYPE "identity_schema"."admins_commission_type_enum"
            AS ENUM ('percent', 'fixed');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "commission_type"
        "identity_schema"."admins_commission_type_enum" NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "commission_value" DOUBLE PRECISION NULL;
    `);

    // --- finance: operator_earnings ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."operator_earnings" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "operator_id" BIGINT NOT NULL,
        "order_id" BIGINT NOT NULL,
        "market_id" BIGINT,
        "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "commission_type" VARCHAR(16),
        "commission_value" DOUBLE PRECISION,
        "order_total_price" DOUBLE PRECISION
      );
    `);

    // Idempotency guard — one earning per order. Partial unique so a soft-
    // deleted (rolled-back) earning doesn't block re-recording on re-sale.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_OPERATOR_EARNING_ORDER"
      ON "finance_schema"."operator_earnings" ("order_id")
      WHERE "is_deleted" = false;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_EARNING_OPERATOR"
      ON "finance_schema"."operator_earnings" ("operator_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_EARNING_MARKET"
      ON "finance_schema"."operator_earnings" ("market_id");
    `);

    // --- finance: operator_payments ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."operator_payments" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "operator_id" BIGINT NOT NULL,
        "market_id" BIGINT,
        "paid_by_id" BIGINT,
        "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "note" TEXT
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_PAYMENT_OPERATOR"
      ON "finance_schema"."operator_payments" ("operator_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_PAYMENT_MARKET"
      ON "finance_schema"."operator_payments" ("market_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OPERATOR_PAYMENT_CREATED"
      ON "finance_schema"."operator_payments" ("createdAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."operator_payments" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."operator_earnings" CASCADE;`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "commission_value";`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "commission_type";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "identity_schema"."admins_commission_type_enum";`,
    );
  }
}
