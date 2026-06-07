import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert posts.post_total_price from `double precision` (float) to exact
 * `numeric(14,2)`. It is an aggregate of order.total_price (migration ...004,
 * now numeric) accumulated via `post_total_price + delta`, so float would
 * re-introduce drift the order migration just removed. API stays `number`.
 *
 * USING cast preserves values. Re-runnable: numeric→numeric is a no-op.
 */
export class PostTotalPriceToNumeric1716000000006 implements MigrationInterface {
  name = 'PostTotalPriceToNumeric1716000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."posts"
        ALTER COLUMN "post_total_price" DROP DEFAULT,
        ALTER COLUMN "post_total_price" TYPE numeric(14,2) USING "post_total_price"::numeric(14,2),
        ALTER COLUMN "post_total_price" SET DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."posts"
        ALTER COLUMN "post_total_price" DROP DEFAULT,
        ALTER COLUMN "post_total_price" TYPE double precision USING "post_total_price"::double precision,
        ALTER COLUMN "post_total_price" SET DEFAULT 0;
    `);
  }
}
