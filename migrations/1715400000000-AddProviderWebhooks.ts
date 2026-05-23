import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.D step 1 — generic inbound provider webhooks.
 *
 * 1. external_integrations gains webhook config: HMAC secret (+ previous for
 *    rotation), the signature header / prefix / algorithm, the delivery-id
 *    header used for replay protection, and an inbound status mapping.
 * 2. provider_webhook_logs records every inbound callback for audit + replay
 *    protection (unique per integration_id + delivery_id).
 *
 * Provider-agnostic: any carrier / post / marketplace is configured as a row
 * in external_integrations; no per-provider tables.
 */
export class AddProviderWebhooks1715400000000 implements MigrationInterface {
  name = 'AddProviderWebhooks1715400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: Array<[string, string]> = [
      ['webhook_secret', 'VARCHAR'],
      ['webhook_secret_previous', 'VARCHAR'],
      ['webhook_signature_header', 'VARCHAR'],
      ['webhook_signature_prefix', 'VARCHAR'],
      ['webhook_algorithm', 'VARCHAR'],
      ['webhook_id_header', 'VARCHAR'],
      ['inbound_status_mapping', 'JSONB'],
    ];
    for (const [name, type] of cols) {
      await queryRunner.query(`
        ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "${name}" ${type} NULL;
      `);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."provider_webhook_logs" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "integration_id" BIGINT,
        "provider_slug" VARCHAR(64),
        "delivery_id" VARCHAR(200),
        "event_type" VARCHAR(64),
        "signature_valid" BOOLEAN NOT NULL DEFAULT false,
        "status" VARCHAR(16) NOT NULL,
        "raw_body" TEXT,
        "parsed_payload" JSONB,
        "error" TEXT,
        "trace_id" VARCHAR(64),
        "processed_at" TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PWH_INTEGRATION"
      ON "integration_schema"."provider_webhook_logs" ("integration_id", "createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PWH_STATUS"
      ON "integration_schema"."provider_webhook_logs" ("status", "createdAt");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PWH_EVENT"
      ON "integration_schema"."provider_webhook_logs" ("event_type", "createdAt");
    `);
    // Replay protection: at most one log per (integration, delivery_id) when a
    // delivery id is present. Providers without one are exempt (NULL allowed).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PWH_DELIVERY"
      ON "integration_schema"."provider_webhook_logs" ("integration_id", "delivery_id")
      WHERE "delivery_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."provider_webhook_logs" CASCADE;`,
    );
    const cols = [
      'webhook_secret',
      'webhook_secret_previous',
      'webhook_signature_header',
      'webhook_signature_prefix',
      'webhook_algorithm',
      'webhook_id_header',
      'inbound_status_mapping',
    ];
    for (const name of cols) {
      await queryRunner.query(`
        ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "${name}";
      `);
    }
  }
}
