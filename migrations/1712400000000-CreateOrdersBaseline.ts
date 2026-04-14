import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrdersBaseline1712400000000 implements MigrationInterface {
  name = 'CreateOrdersBaseline1712400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_where_deliver_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."orders_where_deliver_enum" AS ENUM (''center'', ''address'')';
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
          WHERE t.typname = 'orders_status_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."orders_status_enum" AS ENUM (''created'', ''new'', ''received'', ''on the road'', ''waiting'', ''sold'', ''cancelled'', ''paid'', ''partly_paid'', ''cancelled (sent)'', ''closed'')';
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
          WHERE t.typname = 'orders_source_enum'
            AND n.nspname = '${schema}'
        ) THEN
          EXECUTE 'CREATE TYPE "${schema}"."orders_source_enum" AS ENUM (''internal'', ''external'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."orders" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "market_id" bigint NOT NULL,
        "customer_id" bigint NOT NULL,
        "product_quantity" integer NOT NULL DEFAULT 0,
        "where_deliver" "${schema}"."orders_where_deliver_enum" NOT NULL DEFAULT 'center',
        "total_price" double precision NOT NULL DEFAULT 0,
        "to_be_paid" integer NOT NULL DEFAULT 0,
        "paid_amount" integer NOT NULL DEFAULT 0,
        "status" "${schema}"."orders_status_enum" NOT NULL DEFAULT 'new',
        "comment" text,
        "operator" character varying,
        "operator_id" bigint,
        "post_id" bigint,
        "canceled_post_id" bigint,
        "return_requested" boolean NOT NULL DEFAULT false,
        "sold_at" bigint,
        "district_id" bigint,
        "region_id" bigint,
        "address" character varying,
        "qr_code_token" character varying,
        "external_id" character varying,
        "source" "${schema}"."orders_source_enum" NOT NULL DEFAULT 'internal',
        CONSTRAINT "PK_orders_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."order_items" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "product_id" bigint NOT NULL,
        "order_id" bigint NOT NULL,
        "quantity" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_order_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_items_order_id" FOREIGN KEY ("order_id") REFERENCES "${schema}"."orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}"."order_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}"."orders"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "${schema}"."orders_source_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "${schema}"."orders_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "${schema}"."orders_where_deliver_enum"`);
  }
}
