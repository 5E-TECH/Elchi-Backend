import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NFiXfmq6 — AI buyurtma narxi market kesimida (ega qarori 2026-09-19:
 * "default 300 so'm, firmalarga boshqa-boshqa narx qo'yib bera olaylik").
 *
 * `identity_schema.admins.ai_price_per_order` — market uchun ixtiyoriy narx
 * (so'm, 1 ta AI buyurtma):
 *   - NULL — global `AI_PRICE_PER_ORDER` (sukut 300) ishlaydi;
 *   - 0    — shu market uchun AI bepul (ichki sinov / imtiyozli mijoz);
 *   - manfiy qiymat CHECK bilan taqiqlanadi.
 *
 * Faqat sxema: `ADD COLUMN IF NOT EXISTS` (NULL, defaultsiz — katalog
 * o'zgarishi, jadval qayta yozilmaydi), backfill YO'Q — hamma market global
 * narxda qoladi. CHECK faqat yangi ustunni tekshiradi (hamma qiymat NULL).
 * Qayta ishga tushirish xavfsiz.
 */
export class MarketAiPricePerOrder1716000000118 implements MigrationInterface {
  name = 'MarketAiPricePerOrder1716000000118';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "ai_price_per_order" numeric(14,2)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_admins_ai_price_per_order_non_negative'
        ) THEN
          ALTER TABLE "identity_schema"."admins"
          ADD CONSTRAINT "CHK_admins_ai_price_per_order_non_negative"
          CHECK ("ai_price_per_order" IS NULL OR "ai_price_per_order" >= 0);
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP CONSTRAINT IF EXISTS "CHK_admins_ai_price_per_order_non_negative"
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP COLUMN IF EXISTS "ai_price_per_order"
    `);
  }
}
