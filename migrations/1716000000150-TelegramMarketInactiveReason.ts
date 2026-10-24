import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (G085w5Qr) `telegram_markets.inactive_reason` + `inactive_at` — nofaol
 * guruhning sababi jadvalda ko'rinadi. Qiymatlar: 'kicked' | 'left' |
 * 'blocked_on_send' | 'chat_not_found' (bot aniqlaydi) | 'manual' (admin
 * PATCH is_active=false). Faol qatorda ikkalasi NULL.
 * Mavjud nofaol qatorlar NULL qoladi (frontend «Sabab noma'lum») — minimal
 * variant, activity log'dan to'ldirish qilinmadi.
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class TelegramMarketInactiveReason1716000000150 implements MigrationInterface {
  name = 'TelegramMarketInactiveReason1716000000150';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        ADD COLUMN IF NOT EXISTS "inactive_reason" varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS "inactive_at" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        DROP CONSTRAINT IF EXISTS "CHK_TG_MARKET_INACTIVE_REASON"
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        ADD CONSTRAINT "CHK_TG_MARKET_INACTIVE_REASON" CHECK (
          "inactive_reason" IS NULL OR "inactive_reason" IN
            ('kicked', 'left', 'blocked_on_send', 'chat_not_found', 'manual')
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_markets"
        DROP CONSTRAINT IF EXISTS "CHK_TG_MARKET_INACTIVE_REASON",
        DROP COLUMN IF EXISTS "inactive_at",
        DROP COLUMN IF EXISTS "inactive_reason"
    `);
  }
}
