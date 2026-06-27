import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropOrderMediaRequirementFlags1716000000015
  implements MigrationInterface
{
  name = 'DropOrderMediaRequirementFlags1716000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "cancel_requires_media",
        DROP COLUMN IF EXISTS "sell_requires_media"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "sell_requires_media" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "cancel_requires_media" boolean NOT NULL DEFAULT false
    `);
  }
}
