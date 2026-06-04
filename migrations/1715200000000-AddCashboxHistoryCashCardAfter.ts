import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add cash/card split snapshots to cashbox_history.
 *
 * cashbox_history already records `balance_after` (the total balance right
 * after each operation). Operators need the same point-in-time answer for the
 * cash and card sub-balances: "after this operation, how much was left in cash
 * and how much on card?". Storing the split at write-time means the report is
 * an exact historical snapshot, not a fragile re-derivation from the running
 * balance.
 *
 * Existing rows are left NULL — we cannot reconstruct the true cash/card split
 * at the moment of a past operation, and a fabricated 0/0 would read as a real
 * (wrong) breakdown. New rows populate both columns going forward.
 */
export class AddCashboxHistoryCashCardAfter1715200000000 implements MigrationInterface {
  name = 'AddCashboxHistoryCashCardAfter1715200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
      ADD COLUMN IF NOT EXISTS "balance_cash_after" DOUBLE PRECISION NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
      ADD COLUMN IF NOT EXISTS "balance_card_after" DOUBLE PRECISION NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
      DROP COLUMN IF EXISTS "balance_card_after";
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
      DROP COLUMN IF EXISTS "balance_cash_after";
    `);
  }
}
