import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Track each order's "home" (owning/creating) branch separately from its
 * current physical location.
 *
 * `branch_id` is overwritten to the current branch when an order is received
 * into a branch via a transfer batch, so after a forward move it no longer
 * tells us where the order was created / which branch the market submitted it
 * to. The return-to-market rules need that owning branch: a returned order may
 * be handed to the market at HQ or at the branch that created it, and a branch
 * courier may return directly to its branch only when that branch is the
 * order's home branch.
 *
 * `home_branch_id` is set once at creation and never overwritten. Existing rows
 * are backfilled from their current branch_id (best available approximation).
 */
export class AddOrderHomeBranch1716000000002 implements MigrationInterface {
  name = 'AddOrderHomeBranch1716000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" ADD COLUMN IF NOT EXISTS "home_branch_id" bigint;`,
    );
    // Backfill: best-effort — for legacy orders the current branch is the only
    // signal we have for where they belong.
    await queryRunner.query(
      `UPDATE "order_schema"."orders" SET "home_branch_id" = "branch_id" WHERE "home_branch_id" IS NULL;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "home_branch_id";`,
    );
  }
}
