import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRemainingBaselineTables1713400000000
  implements MigrationInterface
{
  name = 'CreateRemainingBaselineTables1713400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createIdentitySchema(queryRunner);
    await this.createCatalogSchema(queryRunner);
    await this.createLogisticsSchema(queryRunner);
    await this.createFinanceSchema(queryRunner);
    await this.createNotificationSchema(queryRunner);
    await this.createIntegrationSchema(queryRunner);
    await this.createInvestorSchema(queryRunner);
    await this.createC2CSchema(queryRunner);
    await this.createSearchSchema(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_schema"."search_documents"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "c2c_schema"."c2c_orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "c2c_schema"."disputes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "c2c_schema"."reviews"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "c2c_schema"."listings"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "c2c_schema"."c2c_orders_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "c2c_schema"."disputes_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "c2c_schema"."listings_status_enum"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "investor_schema"."profit_shares"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_schema"."investments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "investor_schema"."investors"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "investor_schema"."investors_status_enum"`);

    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."sync_history"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "integration_schema"."sync_queue"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."external_integrations"`,
    );

    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_markets"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "notification_schema"."telegram_markets_group_type_enum"`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "finance_schema"."user_salaries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "finance_schema"."shifts"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."cashbox_history"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "finance_schema"."cashboxes"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "finance_schema"."shifts_status_enum"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."cashbox_history_payment_method_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."cashbox_history_source_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."cashbox_history_operation_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "finance_schema"."cashboxes_cashbox_type_enum"`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "logistics_schema"."posts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "logistics_schema"."districts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "logistics_schema"."regions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "logistics_schema"."posts_status_enum"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "catalog_schema"."products"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "identity_schema"."admins"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "identity_schema"."admins_default_tariff_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "identity_schema"."admins_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "identity_schema"."admins_role_enum"`);
  }

  private async createIdentitySchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "identity_schema"`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'admins_role_enum' AND n.nspname = 'identity_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "identity_schema"."admins_role_enum" AS ENUM (''superadmin'',''admin'',''courier'',''registrator'',''market'',''customer'',''operator'',''market_operator'',''manager'',''branch'',''investor'')';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'admins_status_enum' AND n.nspname = 'identity_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "identity_schema"."admins_status_enum" AS ENUM (''active'',''inactive'')';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'admins_default_tariff_enum' AND n.nspname = 'identity_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "identity_schema"."admins_default_tariff_enum" AS ENUM (''center'',''address'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."admins" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying(100) NOT NULL,
        "phone_number" character varying(20) NOT NULL,
        "extra_number" character varying(20),
        "address" character varying(255),
        "username" character varying(60),
        "password" character varying(255) NOT NULL,
        "refresh_token" character varying(512),
        "salary" decimal(12,2) NOT NULL DEFAULT 0,
        "payment_day" integer,
        "region_id" bigint,
        "district_id" bigint,
        "market_tg_token" character varying(255),
        "market_id" bigint,
        "telegram_id" character varying(64),
        "avatar_id" bigint,
        "role" "identity_schema"."admins_role_enum" NOT NULL DEFAULT 'admin',
        "status" "identity_schema"."admins_status_enum" NOT NULL DEFAULT 'active',
        "tariff_home" integer,
        "tariff_center" integer,
        "add_order" boolean NOT NULL DEFAULT false,
        "default_tariff" "identity_schema"."admins_default_tariff_enum" DEFAULT 'center',
        CONSTRAINT "PK_admins_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admins_phone_number" ON "identity_schema"."admins" ("phone_number")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admins_username" ON "identity_schema"."admins" ("username") WHERE "username" IS NOT NULL`,
    );
  }

  private async createCatalogSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "catalog_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "catalog_schema"."products" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "user_id" bigint NOT NULL,
        "image_url" character varying,
        CONSTRAINT "PK_products_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_products_name_user_id" ON "catalog_schema"."products" ("name","user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PRODUCT_USER_ID" ON "catalog_schema"."products" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PRODUCT_DELETED" ON "catalog_schema"."products" ("is_deleted")`,
    );
  }

  private async createLogisticsSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "logistics_schema"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'posts_status_enum' AND n.nspname = 'logistics_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "logistics_schema"."posts_status_enum" AS ENUM (''new'',''sent'',''received'',''canceled'',''canceled_received'')';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."regions" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "sato_code" character varying NOT NULL,
        CONSTRAINT "PK_regions_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_REGION_SATO_CODE" ON "logistics_schema"."regions" ("sato_code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_REGION_NAME" ON "logistics_schema"."regions" ("name")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."districts" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "sato_code" character varying NOT NULL,
        "region_id" bigint NOT NULL,
        "assigned_region" bigint,
        CONSTRAINT "PK_districts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_DISTRICT_REGION" ON "logistics_schema"."districts" ("region_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_DISTRICT_SATO_CODE" ON "logistics_schema"."districts" ("sato_code")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'logistics_schema'
            AND table_name = 'districts'
            AND constraint_name = 'FK_districts_region_id'
        ) THEN
          ALTER TABLE "logistics_schema"."districts"
            ADD CONSTRAINT "FK_districts_region_id"
            FOREIGN KEY ("region_id")
            REFERENCES "logistics_schema"."regions"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'logistics_schema'
            AND table_name = 'districts'
            AND constraint_name = 'FK_districts_assigned_region'
        ) THEN
          ALTER TABLE "logistics_schema"."districts"
            ADD CONSTRAINT "FK_districts_assigned_region"
            FOREIGN KEY ("assigned_region")
            REFERENCES "logistics_schema"."regions"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."posts" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "courier_id" bigint NOT NULL,
        "post_total_price" double precision NOT NULL DEFAULT 0,
        "order_quantity" integer NOT NULL DEFAULT 0,
        "qr_code_token" character varying,
        "region_id" bigint,
        "status" "logistics_schema"."posts_status_enum" NOT NULL DEFAULT 'new',
        CONSTRAINT "PK_posts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POST_STATUS" ON "logistics_schema"."posts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POST_COURIER" ON "logistics_schema"."posts" ("courier_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POST_REGION" ON "logistics_schema"."posts" ("region_id")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'logistics_schema'
            AND table_name = 'posts'
            AND constraint_name = 'FK_posts_region_id'
        ) THEN
          ALTER TABLE "logistics_schema"."posts"
            ADD CONSTRAINT "FK_posts_region_id"
            FOREIGN KEY ("region_id")
            REFERENCES "logistics_schema"."regions"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  private async createFinanceSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "finance_schema"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='cashboxes_cashbox_type_enum' AND n.nspname='finance_schema') THEN
          EXECUTE 'CREATE TYPE "finance_schema"."cashboxes_cashbox_type_enum" AS ENUM (''main'',''couriers'',''markets'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='cashbox_history_operation_type_enum' AND n.nspname='finance_schema') THEN
          EXECUTE 'CREATE TYPE "finance_schema"."cashbox_history_operation_type_enum" AS ENUM (''INCOME'',''EXPENSE'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='cashbox_history_source_type_enum' AND n.nspname='finance_schema') THEN
          EXECUTE 'CREATE TYPE "finance_schema"."cashbox_history_source_type_enum" AS ENUM (''courier_payment'',''market_payment'',''manual_expense'',''manual_income'',''correction'',''salary'',''sell'',''cancel'',''extra_cost'',''bills'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='cashbox_history_payment_method_enum' AND n.nspname='finance_schema') THEN
          EXECUTE 'CREATE TYPE "finance_schema"."cashbox_history_payment_method_enum" AS ENUM (''cash'',''click'',''click_to_market'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='shifts_status_enum' AND n.nspname='finance_schema') THEN
          EXECUTE 'CREATE TYPE "finance_schema"."shifts_status_enum" AS ENUM (''open'',''closed'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashboxes" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "balance" double precision NOT NULL DEFAULT 0,
        "balance_cash" double precision NOT NULL DEFAULT 0,
        "balance_card" double precision NOT NULL DEFAULT 0,
        "cashbox_type" "finance_schema"."cashboxes_cashbox_type_enum" NOT NULL DEFAULT 'main',
        "user_id" bigint NOT NULL,
        CONSTRAINT "PK_cashboxes_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_USER" ON "finance_schema"."cashboxes" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_TYPE" ON "finance_schema"."cashboxes" ("cashbox_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_USER_TYPE" ON "finance_schema"."cashboxes" ("user_id","cashbox_type")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."cashbox_history" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "operation_type" "finance_schema"."cashbox_history_operation_type_enum" NOT NULL,
        "cashbox_id" bigint NOT NULL,
        "source_type" "finance_schema"."cashbox_history_source_type_enum" NOT NULL,
        "source_id" bigint,
        "source_user_id" bigint,
        "amount" double precision NOT NULL,
        "balance_after" double precision NOT NULL,
        "payment_method" "finance_schema"."cashbox_history_payment_method_enum" NOT NULL DEFAULT 'cash',
        "comment" text,
        "created_by" bigint,
        "payment_date" TIMESTAMPTZ,
        CONSTRAINT "PK_cashbox_history_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_CASHBOX" ON "finance_schema"."cashbox_history" ("cashbox_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_CREATED_AT" ON "finance_schema"."cashbox_history" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_OP_TYPE" ON "finance_schema"."cashbox_history" ("operation_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_SOURCE" ON "finance_schema"."cashbox_history" ("source_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_CREATED_BY" ON "finance_schema"."cashbox_history" ("created_by")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'finance_schema'
            AND table_name = 'cashbox_history'
            AND constraint_name = 'FK_cashbox_history_cashbox_id'
        ) THEN
          ALTER TABLE "finance_schema"."cashbox_history"
            ADD CONSTRAINT "FK_cashbox_history_cashbox_id"
            FOREIGN KEY ("cashbox_id")
            REFERENCES "finance_schema"."cashboxes"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."shifts" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "opened_by" bigint NOT NULL,
        "closed_by" bigint,
        "opened_at" TIMESTAMPTZ NOT NULL,
        "closed_at" TIMESTAMPTZ,
        "status" "finance_schema"."shifts_status_enum" NOT NULL DEFAULT 'open',
        "opening_balance_cash" double precision NOT NULL DEFAULT 0,
        "opening_balance_card" double precision NOT NULL DEFAULT 0,
        "closing_balance_cash" double precision NOT NULL DEFAULT 0,
        "closing_balance_card" double precision NOT NULL DEFAULT 0,
        "total_income_cash" double precision NOT NULL DEFAULT 0,
        "total_income_card" double precision NOT NULL DEFAULT 0,
        "total_expense_cash" double precision NOT NULL DEFAULT 0,
        "total_expense_card" double precision NOT NULL DEFAULT 0,
        "comment" text,
        CONSTRAINT "PK_shifts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SHIFT_OPENED_BY" ON "finance_schema"."shifts" ("opened_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SHIFT_STATUS" ON "finance_schema"."shifts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SHIFT_OPENED_AT" ON "finance_schema"."shifts" ("opened_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."user_salaries" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "user_id" bigint NOT NULL,
        "salary_amount" double precision NOT NULL DEFAULT 0,
        "have_to_pay" double precision NOT NULL DEFAULT 0,
        "payment_day" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_user_salaries_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_salaries_user_id" ON "finance_schema"."user_salaries" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SALARY_USER" ON "finance_schema"."user_salaries" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SALARY_PAYMENT_DAY" ON "finance_schema"."user_salaries" ("payment_day")`,
    );
  }

  private async createNotificationSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "notification_schema"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE t.typname='telegram_markets_group_type_enum' AND n.nspname='notification_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "notification_schema"."telegram_markets_group_type_enum" AS ENUM (''cancel'',''create'')';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_markets" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "market_id" bigint NOT NULL,
        "group_id" character varying NOT NULL,
        "group_type" "notification_schema"."telegram_markets_group_type_enum" NOT NULL,
        "token" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_telegram_markets_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TG_MARKET_ID" ON "notification_schema"."telegram_markets" ("market_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TG_GROUP_TYPE" ON "notification_schema"."telegram_markets" ("group_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TG_MARKET_GROUP" ON "notification_schema"."telegram_markets" ("market_id","group_type")`,
    );
  }

  private async createIntegrationSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "integration_schema"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."external_integrations" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "type" character varying NOT NULL DEFAULT 'api',
        "base_url" character varying,
        "credentials" jsonb,
        "status" character varying NOT NULL DEFAULT 'active',
        "api_url" character varying NOT NULL,
        "api_key" character varying,
        "api_secret" character varying,
        "auth_type" character varying NOT NULL DEFAULT 'api_key',
        "auth_url" character varying,
        "username" character varying,
        "password" character varying,
        "market_id" bigint,
        "is_active" boolean NOT NULL DEFAULT true,
        "field_mapping" jsonb,
        "status_mapping" jsonb,
        "status_sync_config" jsonb,
        "last_sync_at" TIMESTAMPTZ,
        "total_synced_orders" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_external_integrations_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_INTEGRATION_SLUG" ON "integration_schema"."external_integrations" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INTEGRATION_ACTIVE" ON "integration_schema"."external_integrations" ("is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INTEGRATION_MARKET" ON "integration_schema"."external_integrations" ("market_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INTEGRATION_STATUS" ON "integration_schema"."external_integrations" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."sync_queue" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "order_id" bigint,
        "integration_id" bigint NOT NULL,
        "action" character varying NOT NULL,
        "entity_type" character varying,
        "entity_id" character varying,
        "old_status" character varying,
        "new_status" character varying,
        "external_status" character varying,
        "payload" jsonb,
        "status" character varying NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "retry_count" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 3,
        "last_error" text,
        "last_response" jsonb,
        "next_retry_at" TIMESTAMPTZ,
        "synced_at" TIMESTAMPTZ,
        "external_order_id" character varying,
        CONSTRAINT "PK_sync_queue_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_QUEUE_STATUS" ON "integration_schema"."sync_queue" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_QUEUE_INTEGRATION" ON "integration_schema"."sync_queue" ("integration_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_QUEUE_ORDER" ON "integration_schema"."sync_queue" ("order_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_QUEUE_RETRY" ON "integration_schema"."sync_queue" ("status","next_retry_at")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'integration_schema'
            AND table_name = 'sync_queue'
            AND constraint_name = 'FK_sync_queue_integration_id'
        ) THEN
          ALTER TABLE "integration_schema"."sync_queue"
            ADD CONSTRAINT "FK_sync_queue_integration_id"
            FOREIGN KEY ("integration_id")
            REFERENCES "integration_schema"."external_integrations"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."sync_history" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "sync_queue_id" bigint,
        "integration_id" bigint NOT NULL,
        "integration_name" character varying NOT NULL,
        "synced_orders" integer NOT NULL DEFAULT 0,
        "status" character varying,
        "result" jsonb,
        "sync_date" bigint NOT NULL,
        "attempted_at" TIMESTAMPTZ,
        CONSTRAINT "PK_sync_history_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_HISTORY_INTEGRATION" ON "integration_schema"."sync_history" ("integration_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_HISTORY_DATE" ON "integration_schema"."sync_history" ("sync_date")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_HISTORY_QUEUE" ON "integration_schema"."sync_history" ("sync_queue_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SYNC_HISTORY_STATUS" ON "integration_schema"."sync_history" ("status")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'integration_schema'
            AND table_name = 'sync_history'
            AND constraint_name = 'FK_sync_history_integration_id'
        ) THEN
          ALTER TABLE "integration_schema"."sync_history"
            ADD CONSTRAINT "FK_sync_history_integration_id"
            FOREIGN KEY ("integration_id")
            REFERENCES "integration_schema"."external_integrations"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  private async createInvestorSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "investor_schema"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE t.typname='investors_status_enum' AND n.nspname='investor_schema'
        ) THEN
          EXECUTE 'CREATE TYPE "investor_schema"."investors_status_enum" AS ENUM (''active'',''inactive'')';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_schema"."investors" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "user_id" bigint NOT NULL,
        "name" character varying NOT NULL,
        "phone_number" character varying NOT NULL,
        "status" "investor_schema"."investors_status_enum" NOT NULL DEFAULT 'active',
        "description" text,
        CONSTRAINT "PK_investors_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INVESTOR_USER" ON "investor_schema"."investors" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INVESTOR_STATUS" ON "investor_schema"."investors" ("status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_INVESTOR_PHONE_ACTIVE" ON "investor_schema"."investors" ("phone_number") WHERE "is_deleted" = false`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_schema"."investments" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "investor_id" bigint NOT NULL,
        "branch_id" bigint,
        "amount" double precision NOT NULL,
        "invested_at" TIMESTAMPTZ NOT NULL,
        "description" text,
        CONSTRAINT "PK_investments_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INVESTMENT_INVESTOR" ON "investor_schema"."investments" ("investor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_INVESTMENT_BRANCH" ON "investor_schema"."investments" ("branch_id")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'investor_schema'
            AND table_name = 'investments'
            AND constraint_name = 'FK_investments_investor_id'
        ) THEN
          ALTER TABLE "investor_schema"."investments"
            ADD CONSTRAINT "FK_investments_investor_id"
            FOREIGN KEY ("investor_id")
            REFERENCES "investor_schema"."investors"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "investor_schema"."profit_shares" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "investor_id" bigint NOT NULL,
        "amount" double precision NOT NULL,
        "percentage" double precision NOT NULL DEFAULT 0,
        "period_start" TIMESTAMPTZ NOT NULL,
        "period_end" TIMESTAMPTZ NOT NULL,
        "is_paid" boolean NOT NULL DEFAULT false,
        "paid_at" TIMESTAMPTZ,
        "description" text,
        CONSTRAINT "PK_profit_shares_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PROFIT_INVESTOR" ON "investor_schema"."profit_shares" ("investor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PROFIT_PERIOD" ON "investor_schema"."profit_shares" ("period_start","period_end")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'investor_schema'
            AND table_name = 'profit_shares'
            AND constraint_name = 'FK_profit_shares_investor_id'
        ) THEN
          ALTER TABLE "investor_schema"."profit_shares"
            ADD CONSTRAINT "FK_profit_shares_investor_id"
            FOREIGN KEY ("investor_id")
            REFERENCES "investor_schema"."investors"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  private async createC2CSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "c2c_schema"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='listings_status_enum' AND n.nspname='c2c_schema') THEN
          EXECUTE 'CREATE TYPE "c2c_schema"."listings_status_enum" AS ENUM (''active'',''sold'',''cancelled'',''expired'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='disputes_status_enum' AND n.nspname='c2c_schema') THEN
          EXECUTE 'CREATE TYPE "c2c_schema"."disputes_status_enum" AS ENUM (''open'',''in_review'',''resolved'',''closed'')';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typname='c2c_orders_status_enum' AND n.nspname='c2c_schema') THEN
          EXECUTE 'CREATE TYPE "c2c_schema"."c2c_orders_status_enum" AS ENUM (''pending'',''accepted'',''shipped'',''delivered'',''cancelled'',''disputed'')';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "c2c_schema"."listings" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "title" character varying NOT NULL,
        "description" text,
        "price" double precision NOT NULL,
        "seller_id" bigint NOT NULL,
        "category" character varying,
        "images" jsonb,
        "status" "c2c_schema"."listings_status_enum" NOT NULL DEFAULT 'active',
        "location" character varying,
        CONSTRAINT "PK_listings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_LISTING_SELLER" ON "c2c_schema"."listings" ("seller_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_LISTING_STATUS" ON "c2c_schema"."listings" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_LISTING_CATEGORY" ON "c2c_schema"."listings" ("category")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "c2c_schema"."reviews" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "order_id" bigint NOT NULL,
        "reviewer_id" bigint NOT NULL,
        "target_user_id" bigint NOT NULL,
        "rating" integer NOT NULL,
        "comment" text,
        CONSTRAINT "PK_reviews_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_REVIEW_ORDER" ON "c2c_schema"."reviews" ("order_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_REVIEW_REVIEWER" ON "c2c_schema"."reviews" ("reviewer_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_REVIEW_TARGET" ON "c2c_schema"."reviews" ("target_user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "c2c_schema"."disputes" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "order_id" bigint NOT NULL,
        "opened_by" bigint NOT NULL,
        "reason" text NOT NULL,
        "status" "c2c_schema"."disputes_status_enum" NOT NULL DEFAULT 'open',
        "resolution" text,
        "resolved_by" bigint,
        "resolved_at" TIMESTAMPTZ,
        CONSTRAINT "PK_disputes_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_DISPUTE_ORDER" ON "c2c_schema"."disputes" ("order_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_DISPUTE_STATUS" ON "c2c_schema"."disputes" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "c2c_schema"."c2c_orders" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "listing_id" bigint NOT NULL,
        "buyer_id" bigint NOT NULL,
        "seller_id" bigint NOT NULL,
        "price" double precision NOT NULL,
        "status" "c2c_schema"."c2c_orders_status_enum" NOT NULL DEFAULT 'pending',
        "note" text,
        CONSTRAINT "PK_c2c_orders_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_C2C_ORDER_BUYER" ON "c2c_schema"."c2c_orders" ("buyer_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_C2C_ORDER_SELLER" ON "c2c_schema"."c2c_orders" ("seller_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_C2C_ORDER_STATUS" ON "c2c_schema"."c2c_orders" ("status")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'c2c_schema'
            AND table_name = 'c2c_orders'
            AND constraint_name = 'FK_c2c_orders_listing_id'
        ) THEN
          ALTER TABLE "c2c_schema"."c2c_orders"
            ADD CONSTRAINT "FK_c2c_orders_listing_id"
            FOREIGN KEY ("listing_id")
            REFERENCES "c2c_schema"."listings"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  private async createSearchSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "search_schema"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_schema"."search_documents" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "source" character varying(40) NOT NULL,
        "type" character varying(40) NOT NULL,
        "sourceId" character varying(80) NOT NULL,
        "title" character varying(255) NOT NULL,
        "content" text,
        "tags" text[] NOT NULL DEFAULT '{}',
        "metadata" jsonb,
        CONSTRAINT "PK_search_documents_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_search_documents_source_type_sourceId" ON "search_schema"."search_documents" ("source","type","sourceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SEARCH_DOC_TYPE" ON "search_schema"."search_documents" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SEARCH_DOC_DELETED" ON "search_schema"."search_documents" ("is_deleted")`,
    );
  }
}
