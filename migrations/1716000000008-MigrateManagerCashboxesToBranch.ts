import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateManagerCashboxesToBranch1716000000008 implements MigrationInterface {
  name = 'MigrateManagerCashboxesToBranch1716000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "finance_schema"."cashboxes" (
        "balance",
        "balance_cash",
        "balance_card",
        "cashbox_type",
        "user_id",
        "is_deleted"
      )
      SELECT
        0,
        0,
        0,
        'branch',
        branch_user."branch_id",
        false
      FROM "branch_schema"."branch_users" branch_user
      WHERE branch_user."role" = 'MANAGER'
        AND branch_user."is_deleted" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "finance_schema"."cashboxes" branch_cashbox
          WHERE branch_cashbox."user_id" = branch_user."branch_id"
            AND branch_cashbox."cashbox_type" = 'branch'
            AND branch_cashbox."is_deleted" = false
        )
      GROUP BY branch_user."branch_id"
    `);

    await queryRunner.query(`
      CREATE TEMP TABLE "_manager_cashbox_conversion" ON COMMIT DROP AS
      SELECT
        MIN(legacy_cashbox."id") AS legacy_cashbox_id,
        MIN(branch_cashbox."id") AS branch_cashbox_id,
        MIN(legacy_cashbox."balance") AS balance,
        MIN(legacy_cashbox."balance_cash") AS balance_cash,
        MIN(legacy_cashbox."balance_card") AS balance_card
      FROM "branch_schema"."branch_users" branch_user
      INNER JOIN "finance_schema"."cashboxes" legacy_cashbox
        ON legacy_cashbox."user_id" = branch_user."user_id"
       AND legacy_cashbox."cashbox_type" = 'couriers'
       AND legacy_cashbox."is_deleted" = false
      INNER JOIN "finance_schema"."cashboxes" branch_cashbox
        ON branch_cashbox."user_id" = branch_user."branch_id"
       AND branch_cashbox."cashbox_type" = 'branch'
       AND branch_cashbox."is_deleted" = false
      WHERE branch_user."role" = 'MANAGER'
        AND branch_user."is_deleted" = false
        AND branch_cashbox."balance" = 0
        AND branch_cashbox."balance_cash" = 0
        AND branch_cashbox."balance_card" = 0
        AND NOT EXISTS (
          SELECT 1
          FROM "finance_schema"."cashbox_history" history
          WHERE history."cashbox_id" = branch_cashbox."id"
            AND history."is_deleted" = false
        )
      GROUP BY branch_user."branch_id"
      HAVING COUNT(*) = 1
    `);

    await queryRunner.query(`
      UPDATE "finance_schema"."cashboxes" branch_cashbox
      SET
        "balance" = conversion."balance",
        "balance_cash" = conversion."balance_cash",
        "balance_card" = conversion."balance_card",
        "updatedAt" = NOW()
      FROM "_manager_cashbox_conversion" conversion
      WHERE branch_cashbox."id" = conversion."branch_cashbox_id"
    `);

    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_history" history
      SET
        "cashbox_id" = conversion."branch_cashbox_id",
        "updatedAt" = NOW()
      FROM "_manager_cashbox_conversion" conversion
      WHERE history."cashbox_id" = conversion."legacy_cashbox_id"
    `);

    await queryRunner.query(`
      UPDATE "finance_schema"."cashboxes" legacy_cashbox
      SET
        "is_deleted" = true,
        "updatedAt" = NOW()
      FROM "branch_schema"."branch_users" branch_user
      WHERE legacy_cashbox."user_id" = branch_user."user_id"
        AND legacy_cashbox."cashbox_type" = 'couriers'
        AND legacy_cashbox."is_deleted" = false
        AND branch_user."role" = 'MANAGER'
        AND branch_user."is_deleted" = false
    `);
  }

  public async down(): Promise<void> {
    // Manager cashboxes cannot be safely reconstructed after histories are merged.
  }
}
