import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBranchBaselineTables1713300000000 implements MigrationInterface {
  name = 'CreateBranchBaselineTables1713300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'branch_schema';

    await queryRunner.query(`
      CREATE SCHEMA IF NOT EXISTS "${schema}";
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'branches_type_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branches_type_enum" AS ENUM (''HQ'', ''CITY'', ''REGIONAL'', ''DISTRICT'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'branches_status_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branches_status_enum" AS ENUM (''active'', ''inactive'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'branch_users_role_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branch_users_role_enum" AS ENUM (''MANAGER'', ''REGISTRATOR'', ''COURIER'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branches" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "address" character varying,
        "phone_number" character varying,
        "region_id" bigint,
        "district_id" bigint,
        "parent_id" bigint,
        "type" "${schema}"."branches_type_enum" NOT NULL DEFAULT 'DISTRICT',
        "level" integer NOT NULL DEFAULT 0,
        "code" character varying,
        "status" "${schema}"."branches_status_enum" NOT NULL DEFAULT 'active',
        "manager_id" bigint,
        CONSTRAINT "PK_branches_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branch_users" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "branch_id" bigint NOT NULL,
        "user_id" bigint NOT NULL,
        "role" "${schema}"."branch_users_role_enum" NOT NULL DEFAULT 'REGISTRATOR',
        CONSTRAINT "PK_branch_users_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branch_configs" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "branch_id" bigint NOT NULL,
        "config_key" character varying NOT NULL,
        "config_value" jsonb,
        CONSTRAINT "PK_branch_configs_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_STATUS"
      ON "${schema}"."branches" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_REGION"
      ON "${schema}"."branches" ("region_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_PARENT"
      ON "${schema}"."branches" ("parent_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_CODE_UNIQUE"
      ON "${schema}"."branches" ("code")
      WHERE "code" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_USER_BRANCH"
      ON "${schema}"."branch_users" ("branch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_USER_USER"
      ON "${schema}"."branch_users" ("user_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_USER_UNIQUE"
      ON "${schema}"."branch_users" ("branch_id", "user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_CONFIG_BRANCH"
      ON "${schema}"."branch_configs" ("branch_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_CONFIG_KEY"
      ON "${schema}"."branch_configs" ("branch_id", "config_key")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          WHERE tc.constraint_schema = '${schema}'
            AND tc.table_name = 'branch_users'
            AND tc.constraint_name = 'FK_branch_users_branch_id'
        ) THEN
          ALTER TABLE "${schema}"."branch_users"
            ADD CONSTRAINT "FK_branch_users_branch_id"
            FOREIGN KEY ("branch_id")
            REFERENCES "${schema}"."branches"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          WHERE tc.constraint_schema = '${schema}'
            AND tc.table_name = 'branch_configs'
            AND tc.constraint_name = 'FK_branch_configs_branch_id'
        ) THEN
          ALTER TABLE "${schema}"."branch_configs"
            ADD CONSTRAINT "FK_branch_configs_branch_id"
            FOREIGN KEY ("branch_id")
            REFERENCES "${schema}"."branches"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'branch_schema';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_configs"
      DROP CONSTRAINT IF EXISTS "FK_branch_configs_branch_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_users"
      DROP CONSTRAINT IF EXISTS "FK_branch_users_branch_id"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branch_configs"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branch_users"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branches"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branch_users_role_enum"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branches_status_enum"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branches_type_enum"
    `);
  }
}
