import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameFinanceOperationTypeEnumValues1713600000000 implements MigrationInterface {
  name = 'RenameFinanceOperationTypeEnumValues1713600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'cashbox_history_operation_type_enum'
        ) THEN
          BEGIN
            ALTER TYPE "finance_schema"."cashbox_history_operation_type_enum" RENAME VALUE 'INCOME' TO 'income';
          EXCEPTION
            WHEN invalid_parameter_value THEN NULL;
            WHEN undefined_object THEN NULL;
          END;

          BEGIN
            ALTER TYPE "finance_schema"."cashbox_history_operation_type_enum" RENAME VALUE 'EXPENSE' TO 'expense';
          EXCEPTION
            WHEN invalid_parameter_value THEN NULL;
            WHEN undefined_object THEN NULL;
          END;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'cashbox_history_operation_type_enum'
        ) THEN
          BEGIN
            ALTER TYPE "finance_schema"."cashbox_history_operation_type_enum" RENAME VALUE 'income' TO 'INCOME';
          EXCEPTION
            WHEN invalid_parameter_value THEN NULL;
            WHEN undefined_object THEN NULL;
          END;

          BEGIN
            ALTER TYPE "finance_schema"."cashbox_history_operation_type_enum" RENAME VALUE 'expense' TO 'EXPENSE';
          EXCEPTION
            WHEN invalid_parameter_value THEN NULL;
            WHEN undefined_object THEN NULL;
          END;
        END IF;
      END $$;
    `);
  }
}
