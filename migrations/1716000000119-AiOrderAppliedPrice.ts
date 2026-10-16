import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NFiXfmq6 — har yaratilgan AI buyurtma uchun AMAL QILGAN narx (qayd).
 *
 * `ai_schema.ai_order_draft_item.applied_price_uzs` — ai-confirm paytida
 * market narxi (`admins.ai_price_per_order`, bo'sh bo'lsa global
 * `AI_PRICE_PER_ORDER`) shu qatorga MUZLATILADI. Narx keyin o'zgarsa eski
 * yozuvlar qayta hisoblanmaydi (oylik marja orqaga qarab o'zgarmaydi).
 * NULL — ustundan OLDIN yaratilgan buyurtmalar (narx noma'lum; hisobotda
 * `unpricedAiOrders`). `order_id` UNIQUE (1716000000077) — bitta buyurtma
 * ikki marta qayd qilinmaydi (Cp2v3ZJ7: pul faqat bir marta).
 *
 * `IDX_AIDRAFT_ITEM_CREATED` — marja hisobotining davr filtri.
 *
 * Faqat sxema, backfill YO'Q. Jadval kichik (faqat AI buyurtmalar).
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class AiOrderAppliedPrice1716000000119 implements MigrationInterface {
  name = 'AiOrderAppliedPrice1716000000119';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft_item"
      ADD COLUMN IF NOT EXISTS "applied_price_uzs" numeric(14,2)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIDRAFT_ITEM_CREATED"
      ON "ai_schema"."ai_order_draft_item" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ai_schema"."IDX_AIDRAFT_ITEM_CREATED"`,
    );
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft_item"
      DROP COLUMN IF EXISTS "applied_price_uzs"
    `);
  }
}
