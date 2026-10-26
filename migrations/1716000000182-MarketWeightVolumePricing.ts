import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KmWO9gTA — market bo'yicha «Vazn va hajm bo'yicha narx» kaliti (ega qarori
 * 2026-10-19, DAqXPeSy/KmWO9gTA izohlari).
 *
 * `identity_schema.admins.weight_volume_pricing` boolean NOT NULL DEFAULT
 * true. TRUE — sotuvda market tarifi = standart narx (`tariff_home` /
 * `tariff_center`) + vazn/hajm qo'shimchasi (faqat order-service'da
 * `SALE_PRICING_ENGINE=on` bo'lganda); FALSE — faqat standart narx
 * (kelishuvli marketlar). Kalitni faqat SUPERADMIN/ADMIN o'zgartiradi.
 *
 * XAVFSIZLIK: barcha mavjud qatorlar TRUE oladi (ega rejasi: bayroq hamma
 * marketda TRUE, dvigatel esa ALOHIDA yoqiladi) — migratsiyaning o'zi hech
 * qaysi narxni o'zgartirmaydi: `SALE_PRICING_ENGINE` sukuti `off`.
 * PG 11+ da sukutli ustun jadvalni qayta yozmaydi. `IF NOT EXISTS` / jadval
 * tekshiruvi — qayta yurgizish xatosiz.
 *
 * down(): ustun o'chiriladi — admin o'chirib qo'ygan (FALSE) marketlar
 * ro'yxati yo'qoladi.
 */
export class MarketWeightVolumePricing1716000000182 implements MigrationInterface {
  name = 'MarketWeightVolumePricing1716000000182';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('identity_schema.admins') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "identity_schema"."admins"
          ADD COLUMN IF NOT EXISTS "weight_volume_pricing" boolean
          NOT NULL DEFAULT true;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('identity_schema.admins') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "identity_schema"."admins"
          DROP COLUMN IF EXISTS "weight_volume_pricing";
      END
      $$
    `);
  }
}
