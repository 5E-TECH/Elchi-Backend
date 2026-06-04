import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1.D step 4 — dispatch_config on external_integrations.
 *
 * Outbound dispatch config: how to create a shipment at a provider (endpoint,
 * method, body/query templates interpolated from order context, and response
 * paths for the provider's order id / tracking / status). Keeps outbound
 * dispatch provider-agnostic — config, not code.
 */
export class AddDispatchConfig1715700000000 implements MigrationInterface {
  name = 'AddDispatchConfig1715700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
      ADD COLUMN IF NOT EXISTS "dispatch_config" JSONB NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
      DROP COLUMN IF EXISTS "dispatch_config";
    `);
  }
}
