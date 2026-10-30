import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BOT-3b — Telegram bot barqarorligi:
 *
 *  - `telegram_chat_locks` — chat bo'yicha QISQA MUDDATLI (lease) qulf.
 *    Avval `ChatSequencer` Postgres advisory qulfini ochiq TRANZAKSIYA ichida
 *    ushlardi: har faol chat butun ishlov davomida (AI 95 s gacha) bitta
 *    pool ulanishini band qilardi (4 chat × ulanish, pool 10). Endi qulf —
 *    qator (`lock_until`); ulanish faqat olish / uzaytirish / bo'shatish
 *    so'rovi davomida ishlatiladi. Egasi yiqilsa — qator `lock_until` dan
 *    keyin o'z-o'zidan bo'shaydi.
 *  - `telegram_ai_drafts.worker_at` — AI ishini FONDAGI ishchi qachon oldi.
 *    Update «⏳» bilan darhol tugaydi; ishchi `worker_at IS NULL` qoralamani
 *    oladi (qayta urinmaydi), 2 daqiqadan eski `parsing` / `creating` —
 *    «🔁 Qayta urinish» bilan tiklanadi.
 *
 * XAVFSIZLIK: pulga tegmaydi. `IF NOT EXISTS` — qayta yurgizish xatosiz.
 * down(): jadval va ustun o'chiriladi.
 */
export class TelegramChatLocksAiWorker1716000000190 implements MigrationInterface {
  name = 'TelegramChatLocksAiWorker1716000000190';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."telegram_chat_locks" (
        "chat_id" varchar(64) PRIMARY KEY,
        "owner" varchar(64) NOT NULL,
        "lock_until" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_ai_drafts"
        ADD COLUMN IF NOT EXISTS "worker_at" timestamptz NULL
    `);
    // Ishchi navbati: olinmagan / qotgan parsing-creating qoralamalar.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TELEGRAM_AI_DRAFTS_WORK"
      ON "notification_schema"."telegram_ai_drafts" ("updated_at")
      WHERE "status" IN ('parsing', 'creating')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification_schema"."IDX_TELEGRAM_AI_DRAFTS_WORK"`,
    );
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."telegram_ai_drafts"
        DROP COLUMN IF EXISTS "worker_at"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."telegram_chat_locks"`,
    );
  }
}
