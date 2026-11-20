import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial (kassa) Telegram guruhi, 2/3 — kassa yopilganda hisobot filial
 * guruhiga yoki filial menejerlarining SHAXSIY chatiga boradi.
 *
 *  - `telegram_chats`: `chat_title`, `inactive_reason`, `inactive_at`
 *    (filial qatorlari uchun; market qatorlari trigger orqali to'ldiriladi —
 *    ularga tegilmaydi). Filial + scope bo'yicha BITTA qator
 *    (`UQ_TELEGRAM_CHATS_BRANCH`): qayta ulash shu qatorning `chat_id` sini
 *    almashtiradi, tarix activity-log'da.
 *  - `telegram_branch_settings` — hisobot qayerga: `group` (sukut) |
 *    `private` (menejerlarning shaxsiy chatiga). Qator yo'q — `group`.
 *
 * Faqat qo'shimchalar, `IF NOT EXISTS` — qayta yurgizish xatosiz.
 */
export class TelegramBranchChats1716000000248 implements MigrationInterface {
  name = 'TelegramBranchChats1716000000248';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_chats"
        ADD COLUMN IF NOT EXISTS "chat_title" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "inactive_reason" varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS "inactive_at" timestamptz NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_TELEGRAM_CHATS_BRANCH"
        ON "notification_schema"."telegram_chats" ("owner_id", "scope")
        WHERE "owner_type" = 'branch'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_branch_settings" (
        "branch_id" bigint NOT NULL,
        "report_target" varchar(8) NOT NULL DEFAULT 'group',
        "updated_by" bigint NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_branch_settings" PRIMARY KEY ("branch_id"),
        CONSTRAINT "CHK_TELEGRAM_BRANCH_SETTINGS_TARGET"
          CHECK ("report_target" IN ('group', 'private'))
      )
    `);
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
      previous,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_branch_settings"`,
    );
    await queryRunner.query(`
      DELETE FROM "notification_schema"."telegram_chats"
       WHERE "owner_type" = 'branch'
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification_schema"."UQ_TELEGRAM_CHATS_BRANCH"`,
    );
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_chats"
        DROP COLUMN IF EXISTS "inactive_at",
        DROP COLUMN IF EXISTS "inactive_reason",
        DROP COLUMN IF EXISTS "chat_title"
    `);
  }
}
