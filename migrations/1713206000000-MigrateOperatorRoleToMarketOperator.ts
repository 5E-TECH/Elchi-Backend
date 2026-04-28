import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateOperatorRoleToMarketOperator1713206000000
  implements MigrationInterface
{
  name = 'MigrateOperatorRoleToMarketOperator1713206000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE role_enum regtype;
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'identity_schema'
            AND table_name = 'admins'
        ) THEN
          SELECT a.atttypid::regtype
          INTO role_enum
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'identity_schema'
            AND c.relname = 'admins'
            AND a.attname = 'role'
            AND a.attnum > 0
            AND NOT a.attisdropped
          LIMIT 1;

          IF role_enum IS NOT NULL THEN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_enum e
              WHERE e.enumtypid = role_enum
                AND e.enumlabel = 'market_operator'
            ) THEN
              EXECUTE format('ALTER TYPE %s ADD VALUE %L', role_enum, 'market_operator');
            END IF;

            UPDATE identity_schema.admins
            SET role = 'market_operator'
            WHERE role::text = 'operator'
              AND market_id IS NOT NULL;
          END IF;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE role_enum regtype;
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'identity_schema'
            AND table_name = 'admins'
        ) THEN
          SELECT a.atttypid::regtype
          INTO role_enum
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'identity_schema'
            AND c.relname = 'admins'
            AND a.attname = 'role'
            AND a.attnum > 0
            AND NOT a.attisdropped
          LIMIT 1;

          IF role_enum IS NOT NULL THEN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_enum e
              WHERE e.enumtypid = role_enum
                AND e.enumlabel = 'operator'
            ) THEN
              EXECUTE format('ALTER TYPE %s ADD VALUE %L', role_enum, 'operator');
            END IF;

            UPDATE identity_schema.admins
            SET role = 'operator'
            WHERE role::text = 'market_operator'
              AND market_id IS NOT NULL;
          END IF;
        END IF;
      END $$;
    `);
  }
}
