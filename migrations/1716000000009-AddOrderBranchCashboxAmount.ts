import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshot the amount actually credited to a branch cashbox during a sale.
 * Manager-direct sales credit the full collected amount, which can differ from
 * the tariff-adjusted amount the branch owes HQ.
 */
export class AddOrderBranchCashboxAmount1716000000009 implements MigrationInterface {
  name = 'AddOrderBranchCashboxAmount1716000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "branch_cashbox_amount" numeric(14,2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "branch_cashbox_amount";
    `);
  }
}
