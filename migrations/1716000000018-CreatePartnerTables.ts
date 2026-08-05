import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elchi Partner API — 1-qadam: hamkor (partner) va shipment bog'lanish jadvallari.
 *
 * 1. partners — tashqi hamkor (Elchi Marketplace): nom, API kalit HASH'i,
 *    chiquvchi webhook manzili + HMAC sekret (AES-shifrlangan), IP allowlist,
 *    aktivlik.
 * 2. partner_shipment_refs — hamkor `external_order_id` ↔ Elchi `order_id`
 *    bog'lanishi (idempotentlik + teskari qidiruv).
 *
 * Mavjud order/logistics/finance state machine'lariga TEGMAYDI — faqat yangi
 * integration_schema jadvallari. Kontrakt: docs/PARTNER_API.md.
 */
export class CreatePartnerTables1716000000018 implements MigrationInterface {
  name = 'CreatePartnerTables1716000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."partners" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "name" VARCHAR NOT NULL,
        "api_key_hash" VARCHAR NOT NULL,
        "webhook_url" VARCHAR,
        "webhook_secret" VARCHAR,
        "webhook_secret_previous" VARCHAR,
        "ip_allowlist" JSONB,
        "is_active" BOOLEAN NOT NULL DEFAULT true
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PARTNER_API_KEY_HASH"
      ON "integration_schema"."partners" ("api_key_hash");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PARTNER_ACTIVE"
      ON "integration_schema"."partners" ("is_active");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."partner_shipment_refs" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "partner_id" BIGINT NOT NULL,
        "external_order_id" VARCHAR NOT NULL,
        "order_id" BIGINT NOT NULL
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PSR_PARTNER_EXTERNAL"
      ON "integration_schema"."partner_shipment_refs" ("partner_id", "external_order_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PSR_ORDER"
      ON "integration_schema"."partner_shipment_refs" ("order_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."partner_shipment_refs" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."partners" CASCADE;`,
    );
  }
}
