import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notification_schema.push_subscriptions` — brauzer bergan Web Push obunasi
 * (endpoint + p256dh + auth). Saqlanmasa server hech kimga push yubora olmaydi.
 *
 * - `endpoint` TEXT + UNIQUE: FCM endpointlari 300+ belgi bo'ladi, VARCHAR(255)
 *   jonli endpointni KESIB push'ni jimgina o'ldirardi. UNIQUE bo'lmasa bitta
 *   qurilma bir necha qator yaratib, bitta hodisa uchun 3-4 push olardi.
 *   Qayta subscribe — shu kalit bo'yicha UPDATE (id o'zgarmaydi).
 * - `user_agent` 256 belgigacha (servis kesadi), qator shishmasin.
 * - `platform` — 'android' | 'ios' | 'desktop'; `is_standalone` — iOS'da push
 *   faqat bosh ekranga o'rnatilgan PWA ichida ishlaydi, shuni bilish uchun.
 */
export class CreatePushSubscriptions1716000000052 implements MigrationInterface {
  name = 'CreatePushSubscriptions1716000000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."push_subscriptions" (
        "id" BIGSERIAL PRIMARY KEY,
        "user_id" BIGINT NOT NULL,
        "endpoint" TEXT NOT NULL,
        "p256dh" TEXT NOT NULL,
        "auth" TEXT NOT NULL,
        "user_agent" VARCHAR(256),
        "platform" VARCHAR(16) NOT NULL DEFAULT 'desktop'
          CHECK ("platform" IN ('android', 'ios', 'desktop')),
        "is_standalone" BOOLEAN NOT NULL DEFAULT FALSE,
        "last_used_at" TIMESTAMPTZ,
        "last_error" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_PUSH_SUBSCRIPTIONS_ENDPOINT"
      ON "notification_schema"."push_subscriptions" ("endpoint")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PUSH_SUBSCRIPTIONS_USER"
      ON "notification_schema"."push_subscriptions" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PUSH_SUBSCRIPTIONS_USER_LAST_USED"
      ON "notification_schema"."push_subscriptions" ("user_id", "last_used_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."push_subscriptions" CASCADE`,
    );
  }
}
