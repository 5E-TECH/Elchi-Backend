import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBranchTransferBatchTables1713200000000 implements MigrationInterface {
  name = 'CreateBranchTransferBatchTables1713200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'branch_transfer_batch_direction_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branch_transfer_batch_direction_enum" AS ENUM (''FORWARD'', ''RETURN'')';
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
          WHERE t.typname = 'branch_transfer_batch_status_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branch_transfer_batch_status_enum" AS ENUM (''PENDING'', ''SENT'', ''RECEIVED'', ''CANCELLED'')';
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
          WHERE t.typname = 'branch_transfer_batch_action_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."branch_transfer_batch_action_enum" AS ENUM (''CREATED'', ''SENT'', ''RECEIVED'', ''CANCELLED'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branch_transfer_batches" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "qr_code_token" character varying(32) NOT NULL,
        "source_branch_id" bigint NOT NULL,
        "destination_branch_id" bigint NOT NULL,
        "direction" "${schema}"."branch_transfer_batch_direction_enum" NOT NULL,
        "target_region_id" bigint NOT NULL,
        "status" "${schema}"."branch_transfer_batch_status_enum" NOT NULL DEFAULT 'PENDING',
        "order_count" integer NOT NULL DEFAULT 0,
        "total_price" double precision NOT NULL DEFAULT 0,
        "vehicle_plate" character varying(32),
        "driver_name" character varying(128),
        "driver_phone" character varying(32),
        "sent_at" TIMESTAMPTZ,
        "received_at" TIMESTAMPTZ,
        "cancelled_at" TIMESTAMPTZ,
        CONSTRAINT "PK_branch_transfer_batches_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_branch_transfer_batches_qr_code_token" UNIQUE ("qr_code_token")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_SOURCE_BRANCH_ID"
      ON "${schema}"."branch_transfer_batches" ("source_branch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_DESTINATION_BRANCH_ID"
      ON "${schema}"."branch_transfer_batches" ("destination_branch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_TARGET_REGION_ID"
      ON "${schema}"."branch_transfer_batches" ("target_region_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_STATUS"
      ON "${schema}"."branch_transfer_batches" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_DIRECTION"
      ON "${schema}"."branch_transfer_batches" ("direction")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branch_transfer_batch_items" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "batch_id" bigint NOT NULL,
        "order_id" bigint NOT NULL,
        "snapshot_price" double precision NOT NULL,
        "snapshot_market_id" bigint NOT NULL,
        CONSTRAINT "PK_branch_transfer_batch_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_branch_transfer_batch_items_batch_order" UNIQUE ("batch_id", "order_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCH_ITEMS_BATCH_ID"
      ON "${schema}"."branch_transfer_batch_items" ("batch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCH_ITEMS_ORDER_ID"
      ON "${schema}"."branch_transfer_batch_items" ("order_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."branch_transfer_batch_history" (
        "id" BIGSERIAL NOT NULL,
        "batch_id" bigint NOT NULL,
        "user_id" bigint NOT NULL,
        "action" "${schema}"."branch_transfer_batch_action_enum" NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "notes" text,
        CONSTRAINT "PK_branch_transfer_batch_history_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCH_HISTORY_BATCH_ID_CREATED_AT"
      ON "${schema}"."branch_transfer_batch_history" ("batch_id", "created_at")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_schema = '${schema}'
            AND table_name = 'branch_transfer_batch_items'
            AND constraint_name = 'FK_branch_transfer_batch_items_batch_id'
        ) THEN
          ALTER TABLE "${schema}"."branch_transfer_batch_items"
          ADD CONSTRAINT "FK_branch_transfer_batch_items_batch_id"
          FOREIGN KEY ("batch_id")
          REFERENCES "${schema}"."branch_transfer_batches"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_schema = '${schema}'
            AND table_name = 'branch_transfer_batch_items'
            AND constraint_name = 'FK_branch_transfer_batch_items_order_id'
        ) THEN
          ALTER TABLE "${schema}"."branch_transfer_batch_items"
          ADD CONSTRAINT "FK_branch_transfer_batch_items_order_id"
          FOREIGN KEY ("order_id")
          REFERENCES "${schema}"."orders"("id")
          ON DELETE RESTRICT ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_schema = '${schema}'
            AND table_name = 'branch_transfer_batch_history'
            AND constraint_name = 'FK_branch_transfer_batch_history_batch_id'
        ) THEN
          ALTER TABLE "${schema}"."branch_transfer_batch_history"
          ADD CONSTRAINT "FK_branch_transfer_batch_history_batch_id"
          FOREIGN KEY ("batch_id")
          REFERENCES "${schema}"."branch_transfer_batches"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batch_history"
      DROP CONSTRAINT IF EXISTS "FK_branch_transfer_batch_history_batch_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batch_items"
      DROP CONSTRAINT IF EXISTS "FK_branch_transfer_batch_items_order_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batch_items"
      DROP CONSTRAINT IF EXISTS "FK_branch_transfer_batch_items_batch_id"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCH_HISTORY_BATCH_ID_CREATED_AT"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branch_transfer_batch_history"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCH_ITEMS_ORDER_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCH_ITEMS_BATCH_ID"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branch_transfer_batch_items"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_DIRECTION"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_STATUS"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_TARGET_REGION_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_DESTINATION_BRANCH_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_SOURCE_BRANCH_ID"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "${schema}"."branch_transfer_batches"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branch_transfer_batch_action_enum"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branch_transfer_batch_status_enum"
    `);
    await queryRunner.query(`
      DROP TYPE IF EXISTS "${schema}"."branch_transfer_batch_direction_enum"
    `);
  }
}
