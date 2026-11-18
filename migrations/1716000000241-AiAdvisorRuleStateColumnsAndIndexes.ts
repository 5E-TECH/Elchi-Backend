import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (LhTIno57) review round-4 — AI maslahatchi: holat ustunlari va
 * qoida so'rovlari indekslari. Raqam orkestr bilan kelishilgan (241).
 *
 * 1) `ai_schema.ai_advisor_rule_state.last_failed`, `failures` — 226 joyida
 *    tahrirlangan edi: eski 226 ni yurgizgan bazada (dev/review) ustunlar
 *    yo'q, 226 qayta yurmaydi → `saveStates` har tick yiqiladi. Shu yerda
 *    idempotent `ADD COLUMN IF NOT EXISTS`.
 * 2) R3 (g'ayrioddiy xarajat): 30 kunlik oyna statistikasi
 *    `(expense_category_id, createdAt)` bo'yicha; INCLUDE `cashbox_id`,
 *    `amount` — index-only. Faqat qo'lda xarajat qatorlari (partial) —
 *    indeks kichik. O'lchov (6M qator, siyrak filial×kategoriya): 7 kunlik
 *    yetib olish 23.3 s / 2 chaqiruv → 0.94 s / 1 chaqiruv.
 * 3) R1 (smena kamomadi) `prior` LATERAL: har kassa uchun oxirgi mos
 *    smenalar — ifoda `COALESCE(cashbox_user_id, 0)` so'rovdagi bilan AYNAN
 *    bir xil (asosiy kassa = 0), `(closed_at, id)` tartibi bilan; ilgari har
 *    kassa uchun Seq Scan edi (owners × shifts).
 *
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. `CONCURRENTLY` yo'q: production
 * kutilgan migratsiyalarni BITTA tranzaksiyada yurgizadi (scripts/db-prepare.ts).
 * ⚠️ Indeks qurilishi davomida `cashbox_history` / `shifts` ga yozish
 * kutadi (SHARE qulf) — katta bazada relizni kam yuklamali vaqtda.
 * Pulga va ma'lumotga tegmaydi. down(): indekslar olib tashlanadi (ustunlar
 * qoladi — ular hozirgi 226 shaklining qismi).
 */
export class AiAdvisorRuleStateColumnsAndIndexes1716000000241 implements MigrationInterface {
  name = 'AiAdvisorRuleStateColumnsAndIndexes1716000000241';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_advisor_rule_state"
        ADD COLUMN IF NOT EXISTS "last_failed" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "failures" jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_ADVISOR_R3"
        ON "finance_schema"."cashbox_history" ("expense_category_id", "createdAt")
        INCLUDE ("cashbox_id", "amount")
        WHERE "source_type" = 'manual_expense'
          AND "operation_type" = 'expense'
          AND "is_deleted" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SHIFTS_ADVISOR_R1_OWNER_CLOSED"
        ON "finance_schema"."shifts" ((COALESCE("cashbox_user_id", 0)), "closed_at", "id")
        WHERE "status" = 'closed' AND "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_SHIFTS_ADVISOR_R1_OWNER_CLOSED"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_ADVISOR_R3"`,
    );
    // Ustunlar 226 ning hozirgi shaklida ham bor — down faqat 241 dan oldingi
    // (eski 226) holatga qaytaradi; yangi 226 bazada ustunlarni saqlaymiz.
  }
}
