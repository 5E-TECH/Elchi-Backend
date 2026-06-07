import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert the orders money columns from `double precision` (float) to exact
 * `numeric(14,2)`, matching order_settlement and the branches.per_order_share
 * column. Float storage drifts on SUM()/financial aggregations (analytics
 * revenue uses SUM(orders.total_price)); fixed-point keeps reports exact.
 *
 * Columns: total_price (NOT NULL DEFAULT 0), market_tariff, courier_tariff,
 * courier_share, branch_share (all nullable snapshots).
 *
 * The USING cast preserves existing values. Re-runnable: casting numeric→numeric
 * is a harmless no-op, so applying twice is safe.
 */
export class OrderMoneyColumnsToNumeric1716000000004 implements MigrationInterface {
  name = 'OrderMoneyColumnsToNumeric1716000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "total_price" DROP DEFAULT,
        ALTER COLUMN "total_price" TYPE numeric(14,2) USING "total_price"::numeric(14,2),
        ALTER COLUMN "total_price" SET DEFAULT 0;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "market_tariff" TYPE numeric(14,2) USING "market_tariff"::numeric(14,2);
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "courier_tariff" TYPE numeric(14,2) USING "courier_tariff"::numeric(14,2);
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "courier_share" TYPE numeric(14,2) USING "courier_share"::numeric(14,2);
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "branch_share" TYPE numeric(14,2) USING "branch_share"::numeric(14,2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "total_price" DROP DEFAULT,
        ALTER COLUMN "total_price" TYPE double precision USING "total_price"::double precision,
        ALTER COLUMN "total_price" SET DEFAULT 0;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "market_tariff" TYPE double precision USING "market_tariff"::double precision;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "courier_tariff" TYPE double precision USING "courier_tariff"::double precision;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "courier_share" TYPE double precision USING "courier_share"::double precision;
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ALTER COLUMN "branch_share" TYPE double precision USING "branch_share"::double precision;
    `);
  }
}
