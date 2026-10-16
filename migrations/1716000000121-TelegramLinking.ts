import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram bog'lash (td89SKXQ / 9uNhwTZp / BreQwksC / 6jXw0DDr / 4TfLyTrL):
 *
 *  identity_schema.admins:
 *   - `telegram_username varchar(64)`, `telegram_linked_at timestamptz`;
 *   - `telegram_id` ga PARTIAL UNIQUE indeks (`WHERE telegram_id IS NOT NULL`)
 *     — bitta Telegram akkaunt = bitta xodim (bir kuryer boshqasining
 *     buyurtmasini yopa olmasin; kod tekshiruvi yetarli emas). Indeksdan
 *     OLDIN noaniq (bir nechta akkauntga bog'langan) qiymatlar NULL qilinadi
 *     — aks holda indeks yaratilmaydi va deploy yiqiladi; ular qayta
 *     ulanadi (`identity.telegram.resolve` ularni allaqachon fail-closed
 *     rad etardi). Mavjud NULL qatorlarga ta'sir YO'Q.
 *
 *  notification_schema.telegram_link_tokens — bir martalik bog'lash kodi
 *  (faqat SHA-256), TTL 10 daqiqa, `used_at` atomik band qilinadi.
 *  Soft-delete ustuni `is_deleted` (migration-soft-delete guard).
 *
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class TelegramLinking1716000000121 implements MigrationInterface {
  name = 'TelegramLinking1716000000121';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "telegram_username" varchar(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "telegram_linked_at" timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE "identity_schema"."admins"
         SET "telegram_id" = NULL
       WHERE "telegram_id" IN (
             SELECT "telegram_id" FROM "identity_schema"."admins"
              WHERE "telegram_id" IS NOT NULL
              GROUP BY "telegram_id" HAVING count(*) > 1)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ADMINS_TELEGRAM_ID"
      ON "identity_schema"."admins" ("telegram_id")
      WHERE "telegram_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_link_tokens" (
        "token_hash" varchar(64) PRIMARY KEY,
        "purpose" varchar(16) NOT NULL,
        "owner_type" varchar(24) NOT NULL,
        "owner_id" bigint NOT NULL,
        "chat_scope" varchar(8) NOT NULL,
        "group_type" varchar(16) NULL,
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz NULL,
        "used_chat_id" varchar(64) NULL,
        "created_by" bigint NULL,
        "created_ip" varchar(64) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_LINK_TOKENS_EXPIRES"
      ON "notification_schema"."telegram_link_tokens" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_link_tokens"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "identity_schema"."UQ_ADMINS_TELEGRAM_ID"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP COLUMN IF EXISTS "telegram_linked_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP COLUMN IF EXISTS "telegram_username"
    `);
  }
}
