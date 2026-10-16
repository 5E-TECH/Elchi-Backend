import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram bot yadrosi (ZlpXb4Wh / Mvx0h1Fv / UQlmQiGT / GL2GgtEc /
 * 9HIaV80X / bOMYoOtV) — notification_schema:
 *
 *  - `telegram_sessions` — chat holati (xotiradagi Map o'rniga). TTL 24 soat
 *    (`expires_at`, cron tozalaydi); `expires_at IS NULL` — tizim qatori
 *    (polling offset). `state` da PII yo'q — faqat id'lar.
 *  - `telegram_bot_actions` — inline tugma holati: `callback_data = a:<id>`
 *    (64 bayt ichida), qolgani shu qatordan tiklanadi; `consumed_at` —
 *    bir martalik amal.
 *  - `telegram_rate_limits` — kiruvchi (chat 20/daqiqa) va bog'lash kodi
 *    (5/daqiqa → 15 daqiqa blok) hisoblagichlari, replikalararo.
 *  - `telegram_outbox` — chiquvchi xabarlar: avval yoziladi, keyin
 *    yuboriladi; `retry_count` / `max_attempts` → `dead`.
 *  - `telegram_markets`: `token` ustuni ikkiga bo'lindi — `connect_token_hash`
 *    (bir martalik ulash siri) + `bot_slug` (sir emas). Eski `token`
 *    qiymatlari NULL qilinadi (bOMYoOtV #4: bot orqali ulangan guruhlarda u
 *    yerda market tokeni yotardi va har yuborish 404 berardi; jonli bazada
 *    jadval bo'sh). Ustunning o'zi qoladi (eski kod bilan rolling deploy).
 *
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class TelegramBotCore1716000000120 implements MigrationInterface {
  name = 'TelegramBotCore1716000000120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_sessions" (
        "chat_id" varchar(64) PRIMARY KEY,
        "bot_slug" varchar(32) NOT NULL,
        "user_id" bigint NULL,
        "state" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "version" integer NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_SESSIONS_EXPIRES"
      ON "notification_schema"."telegram_sessions" ("expires_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_bot_actions" (
        "action_id" varchar(16) PRIMARY KEY,
        "chat_id" varchar(64) NOT NULL,
        "message_id" bigint NULL,
        "order_id" bigint NULL,
        "actor_user_id" bigint NULL,
        "action" varchar(32) NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "one_shot" boolean NOT NULL DEFAULT true,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_BOT_ACTIONS_EXPIRES"
      ON "notification_schema"."telegram_bot_actions" ("expires_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_rate_limits" (
        "bucket" varchar(96) PRIMARY KEY,
        "window_start" timestamptz NOT NULL,
        "hits" integer NOT NULL DEFAULT 0,
        "blocked_until" timestamptz NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_RATE_LIMITS_UPDATED"
      ON "notification_schema"."telegram_rate_limits" ("updated_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_outbox" (
        "id" bigserial PRIMARY KEY,
        "bot_slug" varchar(32) NOT NULL,
        "chat_id" varchar(64) NOT NULL,
        "method" varchar(32) NOT NULL DEFAULT 'sendMessage',
        "payload" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "retry_count" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 5,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "last_error" varchar(300) NULL,
        "source" varchar(48) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "sent_at" timestamptz NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_OUTBOX_DUE"
      ON "notification_schema"."telegram_outbox" ("status", "next_attempt_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_OUTBOX_CREATED"
      ON "notification_schema"."telegram_outbox" ("created_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
      ADD COLUMN IF NOT EXISTS "connect_token_hash" varchar(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
      ADD COLUMN IF NOT EXISTS "bot_slug" varchar(32) NULL
    `);
    await queryRunner.query(`
      UPDATE "notification_schema"."telegram_markets"
         SET "token" = NULL
       WHERE "token" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
      DROP COLUMN IF EXISTS "bot_slug"
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
      DROP COLUMN IF EXISTS "connect_token_hash"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_outbox"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_rate_limits"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_bot_actions"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_sessions"`,
    );
  }
}
