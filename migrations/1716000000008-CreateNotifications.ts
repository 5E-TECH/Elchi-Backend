import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-recipient in-app notification inbox (notification_schema.notifications).
 *
 * One row per recipient per notification — read-state is per-user. Role/broadcast
 * dispatches fan out into many rows. Realtime/telegram/email/sms are recorded as
 * delivery side-effects in `delivery`.
 */
export class CreateNotifications1716000000008 implements MigrationInterface {
  name = 'CreateNotifications1716000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "notification_schema"`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_schema"."notifications_category_enum" AS ENUM
          ('order','finance','branch','logistics','account','system','marketing');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notification_schema"."notifications_priority_enum" AS ENUM
          ('low','normal','high','critical');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notifications" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "recipient_id" BIGINT NOT NULL,
        "recipient_role" VARCHAR,
        "type" VARCHAR NOT NULL,
        "category" "notification_schema"."notifications_category_enum" NOT NULL DEFAULT 'system',
        "priority" "notification_schema"."notifications_priority_enum" NOT NULL DEFAULT 'normal',
        "title" VARCHAR NOT NULL,
        "body" TEXT,
        "data" JSONB,
        "link" VARCHAR,
        "channels" JSONB,
        "delivery" JSONB,
        "group_key" VARCHAR,
        "is_read" BOOLEAN NOT NULL DEFAULT false,
        "read_at" TIMESTAMPTZ,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_NOTIF_RECIPIENT_READ" ON "notification_schema"."notifications" ("recipient_id","is_read")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_NOTIF_RECIPIENT_CREATED" ON "notification_schema"."notifications" ("recipient_id","createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_NOTIF_TYPE" ON "notification_schema"."notifications" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_NOTIF_GROUP_KEY" ON "notification_schema"."notifications" ("group_key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notifications"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "notification_schema"."notifications_priority_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "notification_schema"."notifications_category_enum"`,
    );
  }
}
