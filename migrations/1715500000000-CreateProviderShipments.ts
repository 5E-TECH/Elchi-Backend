import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.D step 2 — provider shipments (order ↔ external shipment tracking).
 *
 * Generic across carriers/marketplaces: a shipment links an internal order to
 * its counterpart at a provider (external_ref, tracking number) and tracks
 * both the raw provider status and the mapped internal status. One shipment
 * per order (unique order_id) — re-dispatch overwrites provider fields.
 */
export class CreateProviderShipments1715500000000 implements MigrationInterface {
  name = 'CreateProviderShipments1715500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."provider_shipments" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "order_id" BIGINT NOT NULL,
        "integration_id" BIGINT NOT NULL,
        "provider_slug" VARCHAR(64),
        "external_ref" VARCHAR(200),
        "tracking_number" VARCHAR(200),
        "provider_status" VARCHAR(64),
        "internal_status" VARCHAR(32),
        "status_changed_at" TIMESTAMPTZ,
        "send_attempts" INTEGER NOT NULL DEFAULT 0,
        "last_error" TEXT,
        "last_request_id" VARCHAR(200),
        "meta" JSONB
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_SHIPMENT_ORDER"
      ON "integration_schema"."provider_shipments" ("order_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIPMENT_INTEGRATION"
      ON "integration_schema"."provider_shipments" ("integration_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIPMENT_EXTERNAL_REF"
      ON "integration_schema"."provider_shipments" ("external_ref");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIPMENT_TRACKING"
      ON "integration_schema"."provider_shipments" ("tracking_number");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIPMENT_INTERNAL_STATUS"
      ON "integration_schema"."provider_shipments" ("internal_status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."provider_shipments" CASCADE;`,
    );
  }
}
