import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KmWO9gTA — yetkazish narxi dvigatelini sotuvga ulashdagi ikki darvoza
 * sozlamasi (`logistics_schema.delivery_pricing_settings`):
 *
 *   - `min_delivery_price` numeric(14,2) NULL — DARVOZA 1: sotuvda dvigatel
 *     hisoblagan market tarifi kuryer + filial ulushidan VA shu summadan
 *     past bo'lsa kattasiga ko'tariladi (sotuv to'xtamaydi). NULL — faqat
 *     ulushlar.
 *   - `extra_cost_limit_amount` numeric(14,2) NULL — DARVOZA 2: dvigatel
 *     yoqilgan sotuvda kuryer qo'shimcha xarajatining aniq chegarasi. NULL —
 *     tarif jadvalidagi `address.base − center.base`.
 *
 * XAVFSIZLIK: ikkalasi NULL — xulq o'zgarmaydi; ular faqat order-service'da
 * `SALE_PRICING_ENGINE=on` bo'lganda o'qiladi. Qiymat `PATCH
 * /delivery/pricing-settings` bilan (yangi versiya + jurnal) yoziladi.
 * CHECK — manfiy emas. `IF NOT EXISTS` / mavjudlik tekshiruvi — qayta
 * yurgizish xatosiz; jadval yo'q muhitda (142 yurgizilmagan) o'tkaziladi.
 *
 * down(): ustunlar o'chiriladi — admin yozgan qiymatlar (barcha
 * versiyalarda) yo'qoladi.
 */
export class DeliveryPricingSaleGates1716000000183 implements MigrationInterface {
  name = 'DeliveryPricingSaleGates1716000000183';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.delivery_pricing_settings') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          ADD COLUMN IF NOT EXISTS "min_delivery_price" NUMERIC(14,2) NULL;
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          ADD COLUMN IF NOT EXISTS "extra_cost_limit_amount" NUMERIC(14,2) NULL;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_delivery_pricing_settings_sale_gates'
             AND conrelid = 'logistics_schema.delivery_pricing_settings'::regclass
        ) THEN
          ALTER TABLE "logistics_schema"."delivery_pricing_settings"
            ADD CONSTRAINT "CHK_delivery_pricing_settings_sale_gates"
            CHECK (
              ("min_delivery_price" IS NULL OR "min_delivery_price" >= 0)
              AND ("extra_cost_limit_amount" IS NULL OR "extra_cost_limit_amount" >= 0)
            );
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.delivery_pricing_settings') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          DROP CONSTRAINT IF EXISTS "CHK_delivery_pricing_settings_sale_gates";
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          DROP COLUMN IF EXISTS "extra_cost_limit_amount";
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          DROP COLUMN IF EXISTS "min_delivery_price";
      END
      $$
    `);
  }
}
