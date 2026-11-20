import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial (kassa) Telegram guruhi — kassa yopilganda hisobot filial guruhiga
 * yoki filial menejerining SHAXSIY chatiga boradi.
 *
 *  - `telegram_link_tokens.owner_label` — bir martalik kod kimniki ekanini
 *    guruhga aytish uchun (filial nomi). Sir emas.
 *  - `telegram_chats`: `chat_title`, `inactive_reason`, `inactive_at`
 *    (filial qatorlari uchun; market qatorlari trigger orqali to'ldiriladi —
 *    ularga tegilmaydi). Filial + scope bo'yicha BITTA qator
 *    (`UQ_TELEGRAM_CHATS_BRANCH`): qayta ulash shu qatorning `chat_id` sini
 *    almashtiradi, tarix activity-log'da.
 *  - `telegram_branch_settings` — hisobot qayerga: `group` (sukut) |
 *    `private` (menejerlarning shaxsiy chatiga). Qator yo'q — `group`.
 *  - `shift_report_deliveries.recipient_kind` ga `branch` (guruh) va
 *    `branch_manager` (shaxsiy chat) qo'shiladi; unikal kalit
 *    (`UQ_SHIFT_REPORT_DELIVERY_KIND`) endi `recipient_kind` ni ham oladi —
 *    filial id 12 va kuryer id 12 qatori to'qnashmasin.
 *
 * Faqat qo'shimchalar, `IF NOT EXISTS` — qayta yurgizish xatosiz.
 */
export class BranchTelegramGroup1716000000247 implements MigrationInterface {
  name = 'BranchTelegramGroup1716000000247';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ previous }] = (await queryRunner.query(
      `SELECT current_setting('lock_timeout') AS previous`,
    )) as Array<{ previous: string }>;
    await queryRunner.query(`SELECT set_config('lock_timeout', '5s', true)`);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_link_tokens"
        ADD COLUMN IF NOT EXISTS "owner_label" varchar(120) NULL
    `);
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
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_REPORT_DELIVERY_KIND"
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        ADD CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_KIND" CHECK ("recipient_kind" IN
          ('superadmin','courier','market','branch','branch_manager'))
    `);
    // Filial id va foydalanuvchi id turli jadvallardan — bir xil son bo'lishi
    // mumkin: unikal kalitga `recipient_kind` qo'shiladi (eski kalit bilan
    // unikal bo'lgan qatorlar yangisi bilan ham unikal).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_REPORT_DELIVERY_KIND"
        ON "finance_schema"."shift_report_deliveries"
           ("shift_id", "round", "recipient_kind", "recipient_id", "channel")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_SHIFT_REPORT_DELIVERY"`,
    );
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [
      previous,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "finance_schema"."shift_report_deliveries"
       WHERE "recipient_kind" IN ('branch','branch_manager')
    `);
    // Yangi kalit bilan yozilgan (turli tur, bir xil id) jurnal qatorlari —
    // eski kalitga sig'maydi: birinchisi qoladi.
    await queryRunner.query(`
      DELETE FROM "finance_schema"."shift_report_deliveries" a
       USING "finance_schema"."shift_report_deliveries" b
       WHERE a."shift_id" = b."shift_id" AND a."round" = b."round"
         AND a."recipient_id" = b."recipient_id" AND a."channel" = b."channel"
         AND a."id" > b."id"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SHIFT_REPORT_DELIVERY"
        ON "finance_schema"."shift_report_deliveries"
           ("shift_id", "round", "recipient_id", "channel")
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_SHIFT_REPORT_DELIVERY_KIND"`,
    );
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        DROP CONSTRAINT IF EXISTS "CHK_SHIFT_REPORT_DELIVERY_KIND"
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shift_report_deliveries"
        ADD CONSTRAINT "CHK_SHIFT_REPORT_DELIVERY_KIND" CHECK ("recipient_kind" IN
          ('superadmin','courier','market'))
    `);
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
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_link_tokens"
        DROP COLUMN IF EXISTS "owner_label"
    `);
  }
}
