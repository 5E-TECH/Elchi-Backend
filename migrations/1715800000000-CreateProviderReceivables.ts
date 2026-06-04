import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provider COD reconciliation — receivables + remittances.
 *
 * `provider_receivables`: what each provider owes Elchi for COD it collected on
 * delivery (status-only delivery means the order side never touched a cashbox).
 * `provider_remittances`: payments the provider sent back, each settling a set
 * of pending receivables. Reconciliation ledger only — no cashbox postings.
 */
export class CreateProviderReceivables1715800000000 implements MigrationInterface {
  name = 'CreateProviderReceivables1715800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "integration_schema"."provider_receivable_status_enum"
          AS ENUM ('pending', 'settled', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."provider_receivables" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "order_id" BIGINT NOT NULL,
        "integration_id" BIGINT NOT NULL,
        "provider_slug" VARCHAR(64),
        "external_ref" VARCHAR(200),
        "amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
        "status" "integration_schema"."provider_receivable_status_enum"
          NOT NULL DEFAULT 'pending',
        "remittance_id" BIGINT,
        "settled_at" TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_RECEIVABLE_ORDER_INTEGRATION"
        ON "integration_schema"."provider_receivables" ("integration_id", "order_id")
        WHERE is_deleted = false;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_RECEIVABLE_INTEGRATION"
        ON "integration_schema"."provider_receivables" ("integration_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_RECEIVABLE_STATUS"
        ON "integration_schema"."provider_receivables" ("status");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."provider_remittances" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "integration_id" BIGINT NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
        "reference" VARCHAR(200),
        "note" TEXT,
        "settled_count" INTEGER NOT NULL DEFAULT 0,
        "created_by" BIGINT
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_REMITTANCE_INTEGRATION"
        ON "integration_schema"."provider_remittances" ("integration_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."provider_remittances";`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."provider_receivables";`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "integration_schema"."provider_receivable_status_enum";`,
    );
  }
}
