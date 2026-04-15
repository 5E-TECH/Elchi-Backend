import { MigrationInterface, QueryRunner } from 'typeorm';

export class RepairOrderRelationsAndIndexes1712800000000
  implements MigrationInterface
{
  name = 'RepairOrderRelationsAndIndexes1712800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = '${schema}' AND table_name = 'order_items'
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${schema}'
            AND c.conname = 'FK_order_items_order_id'
        ) THEN
          EXECUTE '
            ALTER TABLE "${schema}"."order_items"
            ADD CONSTRAINT "FK_order_items_order_id"
            FOREIGN KEY ("order_id")
            REFERENCES "${schema}"."orders"("id")
            ON DELETE CASCADE
            ON UPDATE NO ACTION
          ';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = '${schema}' AND table_name = 'order_tracking'
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${schema}'
            AND c.conname = 'FK_order_tracking_order_id'
        ) THEN
          EXECUTE '
            ALTER TABLE "${schema}"."order_tracking"
            ADD CONSTRAINT "FK_order_tracking_order_id"
            FOREIGN KEY ("order_id")
            REFERENCES "${schema}"."orders"("id")
            ON DELETE CASCADE
            ON UPDATE NO ACTION
          ';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_items_order_id"
      ON "${schema}"."order_items" ("order_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_tracking_order_id_created_at"
      ON "${schema}"."order_tracking" ("order_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_POST_ID"
      ON "${schema}"."orders" ("post_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_CANCELED_POST_ID"
      ON "${schema}"."orders" ("canceled_post_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_MARKET_ID"
      ON "${schema}"."orders" ("market_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_CUSTOMER_ID"
      ON "${schema}"."orders" ("customer_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_REGION_ID"
      ON "${schema}"."orders" ("region_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_DISTRICT_ID"
      ON "${schema}"."orders" ("district_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_DISTRICT_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_REGION_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_CUSTOMER_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_MARKET_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_CANCELED_POST_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_POST_ID"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_order_items_order_id"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_order_tracking_order_id_created_at"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${schema}'
            AND c.conname = 'FK_order_tracking_order_id'
        ) THEN
          EXECUTE '
            ALTER TABLE "${schema}"."order_tracking"
            DROP CONSTRAINT "FK_order_tracking_order_id"
          ';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${schema}'
            AND c.conname = 'FK_order_items_order_id'
        ) THEN
          EXECUTE '
            ALTER TABLE "${schema}"."order_items"
            DROP CONSTRAINT "FK_order_items_order_id"
          ';
        END IF;
      END $$;
    `);
  }
}
