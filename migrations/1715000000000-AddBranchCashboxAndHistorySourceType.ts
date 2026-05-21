import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchCashboxAndHistorySourceType1715000000000 implements MigrationInterface {
  name = 'AddBranchCashboxAndHistorySourceType1715000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'cashboxes_cashbox_type_enum'
            AND e.enumlabel = 'branch'
        ) THEN
          ALTER TYPE "finance_schema"."cashboxes_cashbox_type_enum" ADD VALUE 'branch';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'cashbox_history_source_type_enum'
            AND e.enumlabel = 'branch_to_main'
        ) THEN
          ALTER TYPE "finance_schema"."cashbox_history_source_type_enum" ADD VALUE 'branch_to_main';
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // PostgreSQL enum value removal is not safe in down migrations without type rebuild.
  }
}

