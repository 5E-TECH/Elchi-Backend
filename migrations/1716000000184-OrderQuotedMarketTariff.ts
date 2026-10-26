import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KmWO9gTA (E'TIBOR bandi) — buyurtma OCHILGANDA yetkazish narxi dvigateli
 * ko'rsatgan taxminiy market tarifi: `order_schema.orders.quoted_market_tariff`
 * numeric(14,2) NULL.
 *
 * Narx SOTUVDA qotiriladi (`market_tariff`), o'lchov esa mahsulotdan jonli
 * o'qiladi — sotuvgacha o'lchov o'zgarsa narx ham o'zgaradi. Shu ustun
 * ochilgandagi qiymatni saqlaydi va sotuvda farq bo'lsa jurnalga
 * (`order.delivery_price_changed`) yoziladi. Faqat `SALE_PRICING_ENGINE=on`
 * marketlarda to'ladi.
 *
 * XAVFSIZLIK: PULGA TEGMAYDI — hech bir kassa oyog'i, settlement yoki hisobot
 * bu ustunni o'qimaydi. Mavjud qatorlar NULL. `IF NOT EXISTS` — qayta
 * yurgizish xatosiz.
 *
 * down(): ustun o'chiriladi — ochilgandagi narxlar yo'qoladi (jurnal qoladi).
 */
export class OrderQuotedMarketTariff1716000000184 implements MigrationInterface {
  name = 'OrderQuotedMarketTariff1716000000184';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('order_schema.orders') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "order_schema"."orders"
          ADD COLUMN IF NOT EXISTS "quoted_market_tariff" NUMERIC(14,2) NULL;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('order_schema.orders') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "order_schema"."orders"
          DROP COLUMN IF EXISTS "quoted_market_tariff";
      END
      $$
    `);
  }
}
