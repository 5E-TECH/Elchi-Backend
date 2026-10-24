import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MH-3 (9fHyFp3y) + ombor kodlari (hY7uacJu): mahsulot o'lchovi va kodlari.
 *
 * O'lchov (yetkazish narxi dvigateli DAqXPeSy shu ustunlardan o'qiydi):
 *   - `weight_kg` numeric(10,3) NULL — og'irlik, kg (kasrli);
 *   - `length_cm`, `width_cm`, `height_cm` integer NULL — o'lchamlar, sm;
 *   - `volumetric_enabled` boolean NOT NULL DEFAULT true — «hajmga qarab
 *     hisoblash» sukut bo'yicha YONIQ.
 *   O'lchov yangi mahsulotda HTTP'da majburiy (MH-S1, gateway DTO), lekin
 *   ustunlar NULLABLE: eski 1 000+ mahsulot va hamkor avtomatik yaratgan
 *   mahsulot (6tGZzupr — «o'lchov kutilmoqda») o'lchovsiz qoladi.
 *   CHECK'lar: og'irlik va har o'lcham `> 0`; L/W/H — uchalasi yoki hech
 *   biri (`num_nulls(...) IN (0, 3)`) — narx dvigateli chala o'lchamni
 *   ko'rmaydi.
 *
 * Kodlar (ombor kirimi / inventarizatsiya skaneri):
 *   - `barcode` varchar(512) NULL — zavod EAN/UPC/GTIN yoki QR matni;
 *     `UQ_products_barcode_user_id` — market ichida yagona, faqat FAOL
 *     (o'chirilmagan) qatorlarda; turli marketlarda bir xil EAN — ruxsat.
 *     Ustun tartibi (barcode, user_id): bitta indeks ham faqat kod bo'yicha
 *     (xodim, market tanlanmagan), ham kod + market bo'yicha qidiruvga
 *     xizmat qiladi.
 *     GTIN (EAN-13/8, UPC-A, UPC-E, GTIN-14, GS1 DataMatrix/QR'dan
 *     ajratilgan) ustunda KANONIK shaklda saqlanadi (`@app/common`
 *     `canonicalGtin`: UPC-A `036000291452` va GTIN-14 `00036000291452` →
 *     `0036000291452`; UPC-E — kengaytirilgan UPC-A sifatida) —
 *     shuning uchun aniq tenglikli unique indeks bir GTIN'ning turli
 *     yozuvlarini ham dublikat deb ushlaydi. Ustun yangi (hamma qatorda
 *     NULL) — ma'lumot migratsiyasi kerak emas.
 *   - `sku_code` varchar(32) — Elchi kodi `ELC-P-000123`, STORED generated
 *     ustun: mavjud qatorlarga shu migratsiyada (jadval qayta yozilganda)
 *     o'zi to'ladi, yangi qatorga INSERT'da o'zi beriladi, o'zgartirib
 *     bo'lmaydi (poygasiz). `GREATEST(6, length(...))` MAJBURIY — oddiy
 *     `lpad(x, 6, '0')` 7+ xonali id'ni 6 belgigacha QISQARTIRADI.
 *     `UQ_products_sku_code` — yagona.
 *
 * XAVFSIZLIK: ma'lumot o'zgartirilmaydi (UPDATE yo'q); `ADD COLUMN IF NOT
 * EXISTS`, cheklov va indeks mavjudligi tekshiriladi — qayta yurgizish
 * xatosiz; jadval yo'q muhitda (yangi baza) hech narsa qilmaydi.
 * QULF: STORED generated ustun jadvalni qayta yozadi (ACCESS EXCLUSIVE) —
 * `products` kichik (~1 000+ qator), millisekundlar.
 * TypeORM introspeksiyasi (`schema:log` / `migration:generate`,
 * `DB_SCHEMA=catalog_schema`) generated ustun ifodasini
 * `catalog_schema.typeorm_metadata` dan o'qiydi — bu migratsiya u jadvalni
 * yaratmaydi (runtime'da kerak emas: `synchronize` o'chiq). Generatsiya
 * vositasi kerak bo'lsa — alohida migratsiyada qo'shiladi.
 *
 * down(): indekslar, cheklovlar va 7 ustun o'chiriladi — kiritilgan o'lchov
 * va shtrix kodlar YO'QOLADI. Revert'dan oldin backup
 * (`npm run migration:run:safe` / `npm run db:backup`).
 */
export class ProductMeasurementsAndCodes1716000000141 implements MigrationInterface {
  name = 'ProductMeasurementsAndCodes1716000000141';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('catalog_schema.products') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE catalog_schema.products
          ADD COLUMN IF NOT EXISTS "weight_kg" numeric(10,3) NULL,
          ADD COLUMN IF NOT EXISTS "length_cm" integer NULL,
          ADD COLUMN IF NOT EXISTS "width_cm" integer NULL,
          ADD COLUMN IF NOT EXISTS "height_cm" integer NULL,
          ADD COLUMN IF NOT EXISTS "volumetric_enabled" boolean NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS "barcode" character varying(512) NULL,
          ADD COLUMN IF NOT EXISTS "sku_code" character varying(32)
            GENERATED ALWAYS AS (
              'ELC-P-' || lpad("id"::text, GREATEST(6, length("id"::text)), '0')
            ) STORED;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'catalog_schema.products'::regclass
             AND conname = 'CHK_products_weight_kg_positive'
        ) THEN
          ALTER TABLE catalog_schema.products
            ADD CONSTRAINT "CHK_products_weight_kg_positive"
            CHECK ("weight_kg" IS NULL OR "weight_kg" > 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'catalog_schema.products'::regclass
             AND conname = 'CHK_products_dimensions_positive'
        ) THEN
          ALTER TABLE catalog_schema.products
            ADD CONSTRAINT "CHK_products_dimensions_positive"
            CHECK (
              ("length_cm" IS NULL OR "length_cm" > 0) AND
              ("width_cm" IS NULL OR "width_cm" > 0) AND
              ("height_cm" IS NULL OR "height_cm" > 0)
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'catalog_schema.products'::regclass
             AND conname = 'CHK_products_dimensions_all_or_none'
        ) THEN
          ALTER TABLE catalog_schema.products
            ADD CONSTRAINT "CHK_products_dimensions_all_or_none"
            CHECK (num_nulls("length_cm", "width_cm", "height_cm") IN (0, 3));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'catalog_schema.products'::regclass
             AND conname = 'CHK_products_barcode_not_blank'
        ) THEN
          ALTER TABLE catalog_schema.products
            ADD CONSTRAINT "CHK_products_barcode_not_blank"
            CHECK ("barcode" IS NULL OR btrim("barcode") <> '');
        END IF;

        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_products_sku_code"
          ON catalog_schema.products ("sku_code");

        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_products_barcode_user_id"
          ON catalog_schema.products ("barcode", "user_id")
          WHERE "is_deleted" = false AND "barcode" IS NOT NULL;
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

        DROP INDEX IF EXISTS catalog_schema."UQ_products_barcode_user_id";
        DROP INDEX IF EXISTS catalog_schema."UQ_products_sku_code";

        ALTER TABLE catalog_schema.products
          DROP CONSTRAINT IF EXISTS "CHK_products_barcode_not_blank",
          DROP CONSTRAINT IF EXISTS "CHK_products_dimensions_all_or_none",
          DROP CONSTRAINT IF EXISTS "CHK_products_dimensions_positive",
          DROP CONSTRAINT IF EXISTS "CHK_products_weight_kg_positive";

        ALTER TABLE catalog_schema.products
          DROP COLUMN IF EXISTS "sku_code",
          DROP COLUMN IF EXISTS "barcode",
          DROP COLUMN IF EXISTS "volumetric_enabled",
          DROP COLUMN IF EXISTS "height_cm",
          DROP COLUMN IF EXISTS "width_cm",
          DROP COLUMN IF EXISTS "length_cm",
          DROP COLUMN IF EXISTS "weight_kg";
      END
      $$;
    `);
  }
}
