import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderMediaRequirementFlags1716000014
  implements MigrationInterface
{
  name = 'AddOrderMediaRequirementFlags1716000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "sell_requires_media" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "cancel_requires_media" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "cancel_requires_media",
        DROP COLUMN IF EXISTS "sell_requires_media"
    `);
  }
}
