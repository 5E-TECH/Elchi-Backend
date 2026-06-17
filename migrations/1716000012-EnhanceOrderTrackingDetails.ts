import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnhanceOrderTrackingDetails1716000012 implements MigrationInterface {
  name = 'EnhanceOrderTrackingDetails1716000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_tracking"
        ADD COLUMN IF NOT EXISTS "action" character varying(64),
        ADD COLUMN IF NOT EXISTS "old_value" jsonb,
        ADD COLUMN IF NOT EXISTS "new_value" jsonb,
        ADD COLUMN IF NOT EXISTS "description" text,
        ADD COLUMN IF NOT EXISTS "metadata" jsonb
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_tracking_action"
      ON "order_schema"."order_tracking" ("action")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_order_tracking_action"
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_tracking"
        DROP COLUMN IF EXISTS "metadata",
        DROP COLUMN IF EXISTS "description",
        DROP COLUMN IF EXISTS "new_value",
        DROP COLUMN IF EXISTS "old_value",
        DROP COLUMN IF EXISTS "action"
    `);
  }
}
