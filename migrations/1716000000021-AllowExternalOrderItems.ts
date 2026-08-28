import { MigrationInterface, QueryRunner } from 'typeorm';

/** C2.5 — external item name/qty bilan, catalog productisiz saqlanishi mumkin. */
export class AllowExternalOrderItems1716000000021 implements MigrationInterface {
  name = 'AllowExternalOrderItems1716000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      ALTER COLUMN "product_id" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      ADD COLUMN IF NOT EXISTS "product_name" VARCHAR(255)
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      ADD CONSTRAINT "CHK_ORDER_ITEM_PRODUCT_OR_NAME"
      CHECK (
        "product_id" IS NOT NULL OR
        NULLIF(BTRIM("product_name"), '') IS NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      DROP CONSTRAINT IF EXISTS "CHK_ORDER_ITEM_PRODUCT_OR_NAME"
    `);
    await queryRunner.query(`
      DELETE FROM "order_schema"."order_items" WHERE "product_id" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      ALTER COLUMN "product_id" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_items"
      DROP COLUMN IF EXISTS "product_name"
    `);
  }
}
