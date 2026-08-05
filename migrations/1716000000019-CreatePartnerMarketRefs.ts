import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elchi Partner API — per-seller market provisioning (C1.5) uchun bog'lanish
 * jadvali: hamkorning `external_seller_id` ↔ Elchi `elchi_market_id`.
 * Idempotentlik (unique (partner_id, external_seller_id)) + egalik.
 * Mavjud order/logistics/finance/identity jadvallariga TEGMAYDI — faqat yangi
 * integration_schema jadvali. Kontrakt: docs/PARTNER_API.md §3.2.
 */
export class CreatePartnerMarketRefs1716000000019 implements MigrationInterface {
  name = 'CreatePartnerMarketRefs1716000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."partner_market_refs" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "partner_id" BIGINT NOT NULL,
        "external_seller_id" VARCHAR NOT NULL,
        "elchi_market_id" BIGINT NOT NULL
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PMR_PARTNER_EXTERNAL"
      ON "integration_schema"."partner_market_refs" ("partner_id", "external_seller_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PMR_MARKET"
      ON "integration_schema"."partner_market_refs" ("elchi_market_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."partner_market_refs" CASCADE;`,
    );
  }
}
