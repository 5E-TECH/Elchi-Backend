import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-3c — Telegram yetkazish holati jim yo'qolmasin:
 *
 *  1. `telegram_outbox.notification_ids bigint[] NULL` — outbox qatori qaysi
 *     inbox qatorlarining `delivery.telegram` ini yakunlaydi. Guruh relay'i
 *     (bekor / market guruhi xabari) endi dispatch TRANZAKSIYASI ichida
 *     outbox'ga yoziladi (`queued`); `sent` / `failed` ni outbox ishchisi
 *     yozadi. DM'da 429/5xx → `retrying` (ilgari `sent` deb yozilardi).
 *  2. `telegram_blocked_chats` — botni bloklagan shaxsiy chat belgisi
 *     MUDDATSIZ (ilgari 24 soatlik sessiya `state.blocked_at` da edi: sessiya
 *     tozalangach bloklagan odamga yana urinilardi). `member` / `/start` da
 *     o'chadi. Mavjud sessiya belgilari ko'chiriladi.
 *
 * XAVFSIZLIK: pulga tegmaydi. `ADD COLUMN … NULL` — faqat metama'lumot.
 * `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` — qayta yurgizish xatosiz.
 * down(): jadval va ustun o'chiriladi (blok belgilari yo'qoladi).
 */
export class TelegramOutboxDeliveryBlocks1716000000192 implements MigrationInterface {
  name = 'TelegramOutboxDeliveryBlocks1716000000192';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        ADD COLUMN IF NOT EXISTS "notification_ids" bigint[] NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_blocked_chats" (
        "chat_id" varchar(64) PRIMARY KEY,
        "reason" varchar(32) NOT NULL,
        "blocked_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO "notification_schema"."telegram_blocked_chats"
             ("chat_id", "reason", "blocked_at")
      SELECT DISTINCT ON ("chat_id") "chat_id", 'blocked_on_send',
             COALESCE(("state"->>'blocked_at')::timestamptz, now())
        FROM "notification_schema"."telegram_sessions"
       WHERE "state" ? 'blocked_at' AND "chat_id" NOT LIKE '-%'
       ORDER BY "chat_id"
      ON CONFLICT ("chat_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_blocked_chats"`,
    );
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_outbox"
        DROP COLUMN IF EXISTS "notification_ids"
    `);
  }
}
