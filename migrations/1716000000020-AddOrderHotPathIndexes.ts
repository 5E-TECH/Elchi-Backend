import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hot-path indexes for the orders table (Audit perf P1).
 *
 * `orders` is the largest, hottest table but had indexes ONLY on FK/filter
 * columns (branch_id, courier_id, operator_id, current_batch_id, ...) and
 * IDX_ORDER_DELETED_AT — nothing on `status`, `createdAt`, `sold_at` or the
 * `holder_*` columns. Yet the default list is a mandatory `createdAt DESC` sort,
 * status is filtered on ~95 code paths, analytics scans `sold_at` ranges, and
 * holder-scoped queries filter `holder_type`/`holder_branch_id`/`holder_courier_id`.
 *
 * These are partial indexes on `is_deleted = false` (the dominant query filter)
 * so they stay lean. `createdAt` is quoted because the base entity keeps it
 * camelCase. IF NOT EXISTS makes the migration safely re-runnable.
 */
export class AddOrderHotPathIndexes1716000000020
  implements MigrationInterface
{
  name = 'AddOrderHotPathIndexes1716000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = '"order_schema"."orders"';

    // status filter + default createdAt DESC sort (the dominant list pattern).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_STATUS_CREATEDAT"
      ON ${t} ("status", "createdAt" DESC)
      WHERE "is_deleted" = false;
    `);

    // Unfiltered list default sort.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_CREATEDAT"
      ON ${t} ("createdAt" DESC)
      WHERE "is_deleted" = false;
    `);

    // Analytics over SOLD orders (sold_at range scans).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_SOLD_AT"
      ON ${t} ("sold_at")
      WHERE "sold_at" IS NOT NULL AND "is_deleted" = false;
    `);

    // Branch-holder scoped queries (manager/branch dashboards & lists).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_HOLDER_BRANCH"
      ON ${t} ("holder_type", "holder_branch_id")
      WHERE "is_deleted" = false;
    `);

    // Courier-custody scoped queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_HOLDER_COURIER"
      ON ${t} ("holder_courier_id")
      WHERE "holder_courier_id" IS NOT NULL AND "is_deleted" = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const idx of [
      'IDX_ORDERS_HOLDER_COURIER',
      'IDX_ORDERS_HOLDER_BRANCH',
      'IDX_ORDERS_SOLD_AT',
      'IDX_ORDERS_CREATEDAT',
      'IDX_ORDERS_STATUS_CREATEDAT',
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "order_schema"."${idx}";`);
    }
  }
}
