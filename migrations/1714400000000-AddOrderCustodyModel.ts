import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderCustodyModel1714400000000 implements MigrationInterface {
  name = 'AddOrderCustodyModel1714400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'order_schema';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_holder_type_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."orders_holder_type_enum" AS ENUM (''HQ'', ''BRANCH'', ''COURIER'')';
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "holder_type" "${schema}"."orders_holder_type_enum" NOT NULL DEFAULT 'HQ',
      ADD COLUMN IF NOT EXISTS "holder_branch_id" bigint NULL,
      ADD COLUMN IF NOT EXISTS "holder_courier_id" bigint NULL,
      ADD COLUMN IF NOT EXISTS "last_handover_at" TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS "last_handover_by" bigint NULL;
    `);

    await queryRunner.query(`
      UPDATE "${schema}"."orders" o
      SET
        "holder_type" = CASE
          WHEN o."courier_id" IS NOT NULL THEN 'COURIER'::"${schema}"."orders_holder_type_enum"
          WHEN o."branch_id" IS NOT NULL AND EXISTS (
            SELECT 1
            FROM "branch_schema"."branches" b
            WHERE b."id" = o."branch_id"
              AND b."is_deleted" = false
              AND b."type" <> 'HQ'
          ) THEN 'BRANCH'::"${schema}"."orders_holder_type_enum"
          ELSE 'HQ'::"${schema}"."orders_holder_type_enum"
        END,
        "holder_branch_id" = CASE
          WHEN o."courier_id" IS NOT NULL THEN o."branch_id"
          WHEN o."branch_id" IS NOT NULL AND EXISTS (
            SELECT 1
            FROM "branch_schema"."branches" b
            WHERE b."id" = o."branch_id"
              AND b."is_deleted" = false
              AND b."type" <> 'HQ'
          ) THEN o."branch_id"
          ELSE NULL
        END,
        "holder_courier_id" = o."courier_id",
        "last_handover_at" = COALESCE(o."updatedAt", o."createdAt"),
        "last_handover_by" = o."operator_id"
      WHERE o."is_deleted" = false;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."order_custody_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_id" bigint NOT NULL,
        "from_holder_type" "${schema}"."orders_holder_type_enum" NULL,
        "to_holder_type" "${schema}"."orders_holder_type_enum" NOT NULL,
        "from_branch_id" bigint NULL,
        "to_branch_id" bigint NULL,
        "from_courier_id" bigint NULL,
        "to_courier_id" bigint NULL,
        "changed_by" character varying(64) NOT NULL,
        "changed_by_role" character varying(32) NOT NULL,
        "note" text NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_custody_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_custody_events_order_id" FOREIGN KEY ("order_id")
          REFERENCES "${schema}"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_custody_events_order_id_created_at"
      ON "${schema}"."order_custody_events" ("order_id", "created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'order_schema';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_order_custody_events_order_id_created_at";
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."order_custody_events";
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "last_handover_by",
      DROP COLUMN IF EXISTS "last_handover_at",
      DROP COLUMN IF EXISTS "holder_courier_id",
      DROP COLUMN IF EXISTS "holder_branch_id",
      DROP COLUMN IF EXISTS "holder_type";
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."orders_holder_type_enum";
    `);
  }
}
