import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-3 (4-band) — guruh kartasi Telegram'ga TRANZAKSIYADAN TASHQARIDA
 * yuboriladi va kechikkan (429 → outbox navbati) karta ham keyin
 * tahrirlanadi:
 *
 *  - `telegram_order_cards.message_id` NULL bo'lishi mumkin — «yuborilmoqda»
 *    joy band qilish qatori (bitta guruhga bitta karta kafolati qisqa
 *    tranzaksiyada, tarmoq kutilmaydi);
 *  - `telegram_outbox.card_order_id` — navbatga tushgan karta xabari qaysi
 *    buyurtmaniki: outbox yuborganda `message_id` ni kartaga O'ZI yozadi
 *    (dead bo'lsa band qilish qatori o'chiriladi).
 *
 * XAVFSIZLIK: pulga tegmaydi. `DROP NOT NULL` / `ADD COLUMN … NULL` —
 * metama'lumot. Qayta yurgizish xatosiz. down(): band qilish qatorlari
 * (`message_id IS NULL`) o'chiriladi, NOT NULL tiklanadi, ustun o'chadi.
 */
export class TelegramOrderCardsPending1716000000191 implements MigrationInterface {
  name = 'TelegramOrderCardsPending1716000000191';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        ALTER COLUMN "message_id" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        ADD COLUMN IF NOT EXISTS "card_order_id" bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        DROP COLUMN IF EXISTS "card_order_id"
    `);
    await queryRunner.query(`
      DELETE FROM "notification_schema"."telegram_order_cards"
       WHERE "message_id" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_order_cards"
        ALTER COLUMN "message_id" SET NOT NULL
    `);
  }
}
