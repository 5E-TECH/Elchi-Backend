import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (h9newLsd #5 / ysBqD9Nx #4) notification_schema.telegram_order_cards —
 * chatdagi buyurtma kartasining message_id si: holat o'zgarganda karta
 * editMessageText/ReplyMarkup bilan yangilanadi (yangi xabar emas).
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class TelegramOrderCards1716000000122 implements MigrationInterface {
  name = 'TelegramOrderCards1716000000122';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_order_cards" (
        "order_id" bigint NOT NULL,
        "chat_id" varchar(64) NOT NULL,
        "message_id" bigint NOT NULL,
        "kind" varchar(16) NOT NULL,
        "actor_user_id" bigint NULL,
        "status" varchar(32) NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("order_id", "chat_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TG_ORDER_CARDS_UPDATED"
      ON "notification_schema"."telegram_order_cards" ("updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_order_cards"`,
    );
  }
}
