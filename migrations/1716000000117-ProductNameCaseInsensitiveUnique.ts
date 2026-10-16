import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aws1oApe: bir marketda "test" va "TEST" (yoki "  test  ") ikki alohida
 * mahsulot bo'lib qolmasin.
 *
 * `IDX_products_name_user_id` (087) registrga SEZGIR edi. Endi qo'shimcha
 * ifoda indeksi:
 *   UNIQUE (lower(btrim("name")), "user_id") WHERE "is_deleted" = false
 * — faqat FAOL qatorlar (As75bkGo: o'chirilgan nom qayta ishlatiladi), nom
 * esa jadvalda ASL registrida qoladi (lower() faqat indeksda). Eski
 * registrga sezgir indeks O'CHIRILMAYDI — yangi indeks yaratilmay qolsa ham
 * avvalgi himoya saqlanadi.
 *
 * XAVFSIZLIK (prod'da yiqilmasligi uchun):
 *   - ma'lumot O'ZGARTIRILMAYDI (UPDATE/DELETE yo'q);
 *   - indeks yaratishdan OLDIN faol registrga befarq dublikatlar sanaladi.
 *     Bor bo'lsa — migratsiya YIQILMAYDI: WARNING yoziladi (guruhlar soni
 *     va namunalar) va indeks YARATILMAYDI. Bu holatda ham catalog-service
 *     yangi dublikatni ilova darajasida (oldindan tekshiruv) 409 bilan rad
 *     etadi. Dublikatlar qo'lda hal qilingach, migratsiyani `down` + `up`
 *     bilan qayta yurgizish kifoya (tavsiya SQL — hisobotda);
 *   - indeks allaqachon bo'lsa — hech narsa qilmaydi (qayta yurgizish
 *     xatosiz); jadval yo'q muhitda ham hech narsa qilmaydi.
 */
export class ProductNameCaseInsensitiveUnique1716000000117 implements MigrationInterface {
  name = 'ProductNameCaseInsensitiveUnique1716000000117';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        dup_count integer;
        samples text;
      BEGIN
        IF to_regclass('catalog_schema.products') IS NULL THEN
          RETURN;
        END IF;

        IF to_regclass('catalog_schema."IDX_products_lower_name_user_id"') IS NOT NULL THEN
          RETURN;
        END IF;

        SELECT count(*), string_agg(sample, '; ')
          INTO dup_count, samples
          FROM (
            SELECT format(
                     'user_id=%s key=%L ids=%s',
                     user_id,
                     lower(btrim(name)),
                     string_agg(id::text, ',' ORDER BY id)
                   ) AS sample
              FROM catalog_schema.products
             WHERE is_deleted = false
             GROUP BY user_id, lower(btrim(name))
            HAVING count(*) > 1
             ORDER BY user_id
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING
            'Aws1oApe: catalog_schema.products da % ta faol registrga befarq (lower(btrim(name)), user_id) dublikat guruhi bor — unique indeks YARATILMADI (ma''lumot o''zgartirilmadi). Namunalar: %. Dublikatlarni qo''lda hal qilib, migratsiyani qayta yurgizing.',
            dup_count, left(samples, 2000);
          RETURN;
        END IF;

        CREATE UNIQUE INDEX "IDX_products_lower_name_user_id"
          ON catalog_schema.products (lower(btrim("name")), "user_id")
          WHERE "is_deleted" = false;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS catalog_schema."IDX_products_lower_name_user_id"`,
    );
  }
}
