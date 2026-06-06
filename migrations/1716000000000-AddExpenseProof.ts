import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configurable, per-market expense/operation proof (image/video) for order
 * sell/cancel.
 *
 * A market stores a SET of enabled proof conditions
 * (identity_schema.admins.expense_proof_conditions, e.g. "cancel_zero_total",
 * "sell_extra_cost"). When a courier's sell/cancel operation matches ANY of
 * them, file proof becomes mandatory — otherwise the whole operation is
 * rejected. Submitted proof keys are stored on:
 *   - finance_schema.cashbox_history.proof_files for expense-bearing ops, and
 *   - order_schema.orders.proof_files as the per-order proof of record (covers
 *     conditions with no expense, e.g. cancelling a zero-total order).
 *
 * Cross-schema by fully-qualified name (runs on the single db-prepare datasource).
 */
export class AddExpenseProof1716000000000 implements MigrationInterface {
  name = 'AddExpenseProof1716000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "expense_proof_conditions" jsonb;`,
    );
    await queryRunner.query(
      `ALTER TABLE "finance_schema"."cashbox_history" ADD COLUMN IF NOT EXISTS "proof_files" jsonb;`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" ADD COLUMN IF NOT EXISTS "proof_files" jsonb;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_schema"."orders" DROP COLUMN IF EXISTS "proof_files";`,
    );
    await queryRunner.query(
      `ALTER TABLE "finance_schema"."cashbox_history" DROP COLUMN IF EXISTS "proof_files";`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "expense_proof_conditions";`,
    );
  }
}
