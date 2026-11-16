import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (LhTIno57) — ega qarori (2026-11-15): tunda (02:30) ochilgan R6
 * ogohlantirishining Telegram xabari Toshkent 09:00 da ketadi; ilova ichi
 * (in_app + realtime) darhol.
 *
 * - `telegram_due_at` — kechiktirilgan Telegram yo'nalishi qachon yuborilishi
 *   kerak; NULL — kutayotgan Telegram yo'q (yuborilgan / kerak emas).
 *
 * ⚠️ Faqat qo'shimcha ustun, IF NOT EXISTS — qayta yurgizish xavfsiz.
 * (228 — «AI kalit va modellar» sessiyasi.)
 */
export class AiAdvisorTelegramDue1716000000229 implements MigrationInterface {
  name = 'AiAdvisorTelegramDue1716000000229';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_schema"."ai_advisor_alerts" ADD COLUMN IF NOT EXISTS "telegram_due_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_ADVISOR_ALERT_TELEGRAM_DUE" ON "ai_schema"."ai_advisor_alerts" ("telegram_due_at") WHERE "telegram_due_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ai_schema"."IDX_AI_ADVISOR_ALERT_TELEGRAM_DUE"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai_schema"."ai_advisor_alerts" DROP COLUMN IF EXISTS "telegram_due_at"`,
    );
  }
}
