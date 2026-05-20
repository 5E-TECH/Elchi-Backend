import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `deleted_at` to orders for TypeORM soft delete.
 *
 * Until now the codebase used the boolean `is_deleted` on BaseEntity to mark
 * rows as deleted. That answers "is this row dead?" but not "WHEN did it die,
 * and who killed it?" — both questions matter for support cases and audit.
 *
 * The new column is added in addition to (not in place of) `is_deleted`.
 * The soft-delete helper keeps both in sync so existing queries that filter
 * on `is_deleted` keep working without change. Going forward, prefer the
 * TypeORM-native softDelete()/softRemove() path which sets `deleted_at`
 * and auto-excludes the row from subsequent queries.
 *
 * Backfill: for rows already marked is_deleted=true, we stamp deleted_at
 * with updated_at as a best-effort timeline marker — we cannot recover the
 * true deletion moment retroactively, but updated_at is the closest proxy.
 */
export class AddOrderDeletedAt1714900000000 implements MigrationInterface {
  name = 'AddOrderDeletedAt1714900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ NULL;
    `);

    // Backfill from existing is_deleted=true rows. NULL stays NULL for
    // active rows so TypeORM's soft-delete filter behaves correctly.
    await queryRunner.query(`
      UPDATE "order_schema"."orders"
      SET "deleted_at" = "updatedAt"
      WHERE "is_deleted" = true AND "deleted_at" IS NULL;
    `);

    // Partial index: we never query "all soft-deleted rows" without an
    // intent to restore/audit them, so a partial index is both small and
    // useful for the trash-bin / recovery UI.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDER_DELETED_AT"
      ON "order_schema"."orders" ("deleted_at")
      WHERE "deleted_at" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDER_DELETED_AT";`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "deleted_at";`,
    );
  }
}
