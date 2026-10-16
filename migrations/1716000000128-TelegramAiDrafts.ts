import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (e7KhaeOO) Botdagi AI buyurtma QORALAMASI — DB'da (xotirada emas): main'ga
 * har push notification-service'ni qayta ko'taradi, xotiradagi sessiya bilan
 * chatdagi yarim tayyor preview'lar o'lardi. Endi eski "✅ Yaratish" tugmasi
 * restartdan keyin ham draftni DB'dan tiklaydi; muddati o'tgani — aniq
 * "eskirgan" javobi.
 *
 *  - `status`: parsing | failed | empty | preview | creating | created | cancelled
 *    (`preview → creating` shartli UPDATE — ikki marta bosish bitta yaratish);
 *  - `input` — operator yuborgan matn + Telegram file_id lar (rasm baytlari
 *    SAQLANMAYDI); mijoz PII bo'lishi mumkin — `expires_at` (24 soat) dan
 *    keyin soatlik tozalashda O'CHIRILADI.
 * Qayta ishga tushirish xavfsiz.
 */
export class TelegramAiDrafts1716000000128 implements MigrationInterface {
  name = 'TelegramAiDrafts1716000000128';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_ai_drafts" (
        "id" uuid PRIMARY KEY,
        "chat_id" varchar(64) NOT NULL,
        "actor_user_id" bigint NOT NULL,
        "status" varchar(16) NOT NULL,
        "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "ai_draft_id" uuid NULL,
        "orders" jsonb NULL,
        "results" jsonb NULL,
        "message_id" bigint NULL,
        "error" varchar(300) NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
        CONSTRAINT "CHK_TELEGRAM_AI_DRAFT_STATUS" CHECK ("status" IN
          ('parsing', 'failed', 'empty', 'preview', 'creating', 'created', 'cancelled'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TELEGRAM_AI_DRAFTS_EXPIRES"
      ON "notification_schema"."telegram_ai_drafts" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_ai_drafts"`,
    );
  }
}
