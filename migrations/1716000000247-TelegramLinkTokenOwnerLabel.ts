import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial (kassa) Telegram guruhi, 1/3 — `telegram_link_tokens.owner_label`:
 * bir martalik kod kim uchun ekanini guruhga aytish (filial nomi). Sir emas.
 * Qayta yurgizish xatosiz (`IF NOT EXISTS`).
 */
export class TelegramLinkTokenOwnerLabel1716000000247 implements MigrationInterface {
  name = 'TelegramLinkTokenOwnerLabel1716000000247';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_link_tokens"
        ADD COLUMN IF NOT EXISTS "owner_label" varchar(120) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_link_tokens"
        DROP COLUMN IF EXISTS "owner_label"
    `);
  }
}
