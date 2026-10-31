import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-3d (13-band) — ko'p bo'lakli Telegram xabari (4096 belgidan uzun) qayta
 * urinishda TAKROR yuborilmasin: `telegram_outbox.parts_sent` — nechta bo'lak
 * allaqachon yetkazilgan; qayta urinish faqat qolganlarini yuboradi (avval
 * 2-bo'lakda 429 bo'lsa, 1-bo'lak ham qayta ketardi).
 *
 * XAVFSIZLIK: pulga tegmaydi. `ADD COLUMN … NOT NULL DEFAULT 0` (doimiy
 * sukut) — PG 11+ da faqat metama'lumot. `IF NOT EXISTS` — qayta yurgizish
 * xatosiz. down(): ustun o'chiriladi.
 */
export class TelegramOutboxPartsSent1716000000199 implements MigrationInterface {
  name = 'TelegramOutboxPartsSent1716000000199';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        ADD COLUMN IF NOT EXISTS "parts_sent" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        DROP COLUMN IF EXISTS "parts_sent"
    `);
  }
}
