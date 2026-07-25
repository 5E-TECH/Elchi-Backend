import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtraCostFinancialSourceTypes1716000000017
  implements MigrationInterface
{
  name = 'AddExtraCostFinancialSourceTypes1716000000017';

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
            AND t.typname = 'financial_balance_history_source_type_enum'
            AND e.enumlabel = 'sell_extra_cost'
        ) THEN
          ALTER TYPE "finance_schema"."financial_balance_history_source_type_enum"
            ADD VALUE 'sell_extra_cost';
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
            AND t.typname = 'financial_balance_history_source_type_enum'
            AND e.enumlabel = 'cancel_extra_cost'
        ) THEN
          ALTER TYPE "finance_schema"."financial_balance_history_source_type_enum"
            ADD VALUE 'cancel_extra_cost';
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // PostgreSQL enum value removal is not safe without rebuilding the type.
  }
}
