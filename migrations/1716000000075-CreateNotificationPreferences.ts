import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (mP1WGG1W) `notification_schema.notification_preferences` — qabul qiluvchi
 * qaysi tur/kategoriya uchun qaysi kanalni olishini o'zi tanlaydi.
 *
 * - UNIQUE (user_id, scope, channel): bitta sozlama — bitta qator, PATCH
 *   `ON CONFLICT ... DO UPDATE` bilan yangilaydi (dublikat rad etiladi).
 * - `IDX_NOTIF_PREF_USER` (user_id): dispatch filtri BITTA
 *   `user_id = ANY(...)` so'rovi bilan o'qiydi (sikl ichida emas).
 * - Soft-delete ustuni AYNAN `is_deleted` (BaseEntity), `createdAt` /
 *   `updatedAt` esa camelCase — BaseEntity bilan aynan bir xil.
 * - Tinch soatlar bu jadvalda EMAS: `identity_schema.user.settings` JSONB
 *   (`notifications.quiet_hours`) — migratsiya kerak emas.
 */
export class CreateNotificationPreferences1716000000075 implements MigrationInterface {
  name = 'CreateNotificationPreferences1716000000075';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_preferences" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "user_id" BIGINT NOT NULL,
        "scope" VARCHAR(120) NOT NULL,
        "channel" VARCHAR(16) NOT NULL,
        "enabled" BOOLEAN NOT NULL,
        CONSTRAINT "PK_notification_preferences_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_NOTIF_PREF_USER_SCOPE_CHANNEL" UNIQUE ("user_id", "scope", "channel")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_PREF_USER"
      ON "notification_schema"."notification_preferences" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_preferences"`,
    );
  }
}
