import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (ysBqD9Nx, EGA QARORI 2026-09-20) `admins.tg_group_show_customer_pii` —
 * market Telegram guruhi kartasida mijoz ismi/telefoni ko'rinadimi. Sukut
 * TRUE (ega tanlovi); market o'chirishni so'rasa kodsiz o'chiriladi.
 * Qayta ishga tushirish xavfsiz.
 */
export class MarketTelegramGroupPii1716000000127 implements MigrationInterface {
  name = 'MarketTelegramGroupPii1716000000127';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "tg_group_show_customer_pii" BOOLEAN NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "tg_group_show_customer_pii"
    `);
  }
}
