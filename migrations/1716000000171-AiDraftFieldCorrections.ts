import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * J3hEDtFN #4 — operator tuzatishlari (`field_corrections`).
 *
 * `ai_schema.ai_order_draft_item.field_corrections` (jsonb, NULL'li):
 * `{ "<maydon>": { "ai": <AI taklifi>, "final": <operator tasdiqlagani> } }`
 * — faqat o'zgargan maydonlar (`edited_fields` bilan bir xil to'plam).
 * Gateway SERVER tomonda hisoblaydi (mijozdan olinmaydi). Keyingi eval
 * to'plamining manbai (`scripts/ai-eval-collect.ts`).
 *
 * ⚠️ MAXFIYLIK: telefon ikkala tomonda faqat maskalangan; ism/manzil bor —
 * draft matni bilan bir xil retention (30 kun) tugagach NULL
 * (`AI_DRAFT_ITEM_PURGE_SQL`).
 *
 * Qayta yurgizish xavfsiz (IF NOT EXISTS), mavjud ma'lumotga tegmaydi.
 */
export class AiDraftFieldCorrections1716000000171 implements MigrationInterface {
  name = 'AiDraftFieldCorrections1716000000171';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft_item"
        ADD COLUMN IF NOT EXISTS "field_corrections" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft_item"
        DROP COLUMN IF EXISTS "field_corrections"
    `);
  }
}
