import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AQ9lkgVB — hajm chegarasi (ega qarori 2026-10-25): «qaysi hajmdan boshlab
 * narx hajmga qarab hisoblanadi».
 *
 * `logistics_schema.delivery_pricing_settings.volumetric_from_kg`
 * numeric(10,3) NOT NULL DEFAULT 0, CHECK 0..1000. Hisob —
 * `@app/common` `computeDeliveryQuote`: hajmli vazn (Σ U×K×B / 5000) shu
 * qiymatdan KICHIK bo'lsa hajm hisobga olinmaydi (faqat haqiqiy og'irlik),
 * katta yoki teng bo'lsa — odatdagidek katta(haqiqiy, hajmli).
 *
 * XAVFSIZLIK: sukut 0 — xulq O'ZGARMAYDI (mavjud faol qator va eski
 * versiyalar 0 oladi). Haqiqiy chegara (masalan 3 kg) ops vositalaridan
 * `PATCH /delivery/pricing-settings` bilan yoziladi — yangi versiya va
 * jurnal bilan; migratsiya narxni jimgina o'zgartirmaydi. `IF NOT EXISTS` /
 * mavjudlik tekshiruvi — qayta yurgizish xatosiz; jadval yo'q muhitda
 * (142 yurgizilmagan) o'tkazib yuboriladi.
 *
 * down(): ustun o'chiriladi — admin yozgan chegaralar (barcha versiyalarda)
 * yo'qoladi va hajm yana har doim qo'llanadi.
 */
export class DeliveryPricingVolumetricFromKg1716000000154 implements MigrationInterface {
  name = 'DeliveryPricingVolumetricFromKg1716000000154';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.delivery_pricing_settings') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          ADD COLUMN IF NOT EXISTS "volumetric_from_kg" NUMERIC(10,3)
          NOT NULL DEFAULT 0;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_delivery_pricing_settings_volumetric_from_kg'
             AND conrelid = 'logistics_schema.delivery_pricing_settings'::regclass
        ) THEN
          ALTER TABLE "logistics_schema"."delivery_pricing_settings"
            ADD CONSTRAINT "CHK_delivery_pricing_settings_volumetric_from_kg"
            CHECK ("volumetric_from_kg" >= 0 AND "volumetric_from_kg" <= 1000);
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
          DROP CONSTRAINT IF EXISTS "CHK_delivery_pricing_settings_volumetric_from_kg";
        ALTER TABLE "logistics_schema"."delivery_pricing_settings"
          DROP COLUMN IF EXISTS "volumetric_from_kg";
      END
      $$
    `);
  }
}
