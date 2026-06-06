import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configurable courier/branch compensation + per-order settlement chain.
 *
 * - admins.compensation_mode      — courier per-order pay model
 * - branches.ownership / per_order_share — branch ownership + partner share
 * - orders.courier_share / branch_share  — amounts kept, snapshotted at sale
 * - order_settlement              — per-order COD settlement state machine
 *
 * Cross-schema: runs on the single db-prepare datasource using fully-qualified
 * names. Idempotent (IF NOT EXISTS / guarded enum creation).
 */
export class AddCompensationAndSettlement1716000000003
  implements MigrationInterface
{
  name = 'AddCompensationAndSettlement1716000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- enum types (guarded) ---
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "identity_schema"."admins_compensation_mode_enum" AS ENUM
          ('salary_only', 'per_order', 'salary_plus_per_order');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "branch_schema"."branches_ownership_enum" AS ENUM
          ('owned', 'partner');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "order_schema"."order_settlement_status_enum" AS ENUM
          ('pending', 'courier_settled', 'branch_settled', 'market_settled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    // --- courier compensation mode ---
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "compensation_mode"
        "identity_schema"."admins_compensation_mode_enum"
        NOT NULL DEFAULT 'per_order';
    `);

    // --- branch ownership + partner per-order share ---
    await queryRunner.query(`
      ALTER TABLE "branch_schema"."branches"
      ADD COLUMN IF NOT EXISTS "ownership"
        "branch_schema"."branches_ownership_enum"
        NOT NULL DEFAULT 'owned';
    `);
    await queryRunner.query(`
      ALTER TABLE "branch_schema"."branches"
      ADD COLUMN IF NOT EXISTS "per_order_share" numeric(14,2) NOT NULL DEFAULT 0;
    `);

    // --- order sale snapshots ---
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "courier_share" double precision;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "branch_share" double precision;
    `);

    // --- per-order settlement table ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_schema"."order_settlement" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "order_id" bigint NOT NULL,
        "courier_id" bigint,
        "branch_id" bigint,
        "market_id" bigint,
        "courier_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "branch_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "market_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "status" "order_schema"."order_settlement_status_enum" NOT NULL DEFAULT 'pending',
        "courier_to_branch_at" timestamptz,
        "courier_to_branch_by" bigint,
        "branch_to_hq_at" timestamptz,
        "branch_to_hq_by" bigint,
        "hq_to_market_at" timestamptz,
        "hq_to_market_by" bigint
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_settlement_order_id"
        ON "order_schema"."order_settlement" ("order_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_status"
        ON "order_schema"."order_settlement" ("status");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_courier"
        ON "order_schema"."order_settlement" ("courier_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_branch"
        ON "order_schema"."order_settlement" ("branch_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_settlement_market"
        ON "order_schema"."order_settlement" ("market_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_schema"."order_settlement";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "order_schema"."order_settlement_status_enum";`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "branch_share";`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "courier_share";`,
    );
    await queryRunner.query(
      `ALTER TABLE "branch_schema"."branches" DROP COLUMN IF EXISTS "per_order_share";`,
    );
    await queryRunner.query(
      `ALTER TABLE "branch_schema"."branches" DROP COLUMN IF EXISTS "ownership";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "branch_schema"."branches_ownership_enum";`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "compensation_mode";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "identity_schema"."admins_compensation_mode_enum";`,
    );
  }
}
