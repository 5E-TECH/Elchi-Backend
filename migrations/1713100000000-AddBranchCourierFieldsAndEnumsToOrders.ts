import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchCourierFieldsAndEnumsToOrders1713100000000
  implements MigrationInterface
{
  name = 'AddBranchCourierFieldsAndEnumsToOrders1713100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_source_enum'
            AND n.nspname = '${schema}'
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_source_enum'
            AND n.nspname = '${schema}'
            AND e.enumlabel = 'branch'
        ) THEN
          EXECUTE 'ALTER TYPE "${schema}"."orders_source_enum" ADD VALUE ''branch''';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_status_enum'
            AND n.nspname = '${schema}'
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_status_enum'
            AND n.nspname = '${schema}'
            AND e.enumlabel = 'waiting_customer'
        ) THEN
          EXECUTE 'ALTER TYPE "${schema}"."orders_status_enum" ADD VALUE ''waiting_customer''';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_status_enum'
            AND n.nspname = '${schema}'
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_status_enum'
            AND n.nspname = '${schema}'
            AND e.enumlabel = 'returned_to_market'
        ) THEN
          EXECUTE 'ALTER TYPE "${schema}"."orders_status_enum" ADD VALUE ''returned_to_market''';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "branch_id" bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "current_batch_id" bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "courier_id" bigint NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "assigned_at" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "return_reason" text NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_BRANCH_ID"
      ON "${schema}"."orders" ("branch_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_CURRENT_BATCH_ID"
      ON "${schema}"."orders" ("current_batch_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_COURIER_ID"
      ON "${schema}"."orders" ("courier_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_COURIER_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_CURRENT_BATCH_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_BRANCH_ID"
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "return_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "assigned_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "courier_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "current_batch_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "branch_id"
    `);

    // Postgres enum value remove support is limited, so enum labels are intentionally kept in down migration.
  }
}

