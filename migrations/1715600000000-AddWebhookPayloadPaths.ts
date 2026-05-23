import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.D step 3 — webhook_payload_paths on external_integrations.
 *
 * Dot-paths telling the framework where to read shipment fields (external_ref,
 * tracking_number, status, event) out of a provider's webhook body. Keeps the
 * inbound pipeline provider-agnostic: each carrier's payload shape is config,
 * not code.
 */
export class AddWebhookPayloadPaths1715600000000 implements MigrationInterface {
  name = 'AddWebhookPayloadPaths1715600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
      ADD COLUMN IF NOT EXISTS "webhook_payload_paths" JSONB NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
      DROP COLUMN IF EXISTS "webhook_payload_paths";
    `);
  }
}
