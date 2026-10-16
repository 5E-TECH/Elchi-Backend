import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * zRqDRLAZ: mahsulot narxi.
 *
 * Buyurtma formasidagi mahsulot kartochkasida narx satri chizilgan, lekin
 * `products` jadvalida narx ustuni umuman yo'q edi — har doim bo'sh "so'm".
 * Endi ixtiyoriy `price numeric(14,2)` (pul ustunlari standarti) va
 * `price >= 0` tekshiruvi.
 *
 * XAVFSIZLIK: faqat sxema — mavjud qatorlarga tegilmaydi (hammasi `NULL`
 * bo'lib qoladi, backfill yo'q). `ADD COLUMN IF NOT EXISTS` va cheklov
 * mavjudligi tekshiriladi — qayta yurgizish xatosiz. Jadval yo'q muhitda
 * (yangi baza) hech narsa qilmaydi.
 */
export class ProductPrice1716000000116 implements MigrationInterface {
  name = 'ProductPrice1716000000116';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('catalog_schema.products') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE catalog_schema.products
          ADD COLUMN IF NOT EXISTS "price" numeric(14,2) NULL;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'catalog_schema.products'::regclass
             AND conname = 'CHK_products_price_non_negative'
        ) THEN
          ALTER TABLE catalog_schema.products
            ADD CONSTRAINT "CHK_products_price_non_negative"
            CHECK ("price" IS NULL OR "price" >= 0);
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('catalog_schema.products') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE catalog_schema.products
          DROP CONSTRAINT IF EXISTS "CHK_products_price_non_negative";
        ALTER TABLE catalog_schema.products
          DROP COLUMN IF EXISTS "price";
      END
      $$;
    `);
  }
}
