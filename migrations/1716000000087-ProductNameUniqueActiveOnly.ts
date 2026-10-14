import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * As75bkGo: o'chirilgan mahsulot nomini qayta ishlatish.
 *
 * Mahsulot soft-delete qilinadi (`is_deleted = true`), lekin
 * `(name, user_id)` unique indeksi o'chirilgan qatorlarni HAM hisobga olardi:
 * market mahsulotni o'chirib, AYNI nom bilan qayta yaratsa 409 olardi
 * ("Bu marketda bu nomdagi product allaqachon mavjud"), ro'yxatda esa bunday
 * mahsulot yo'q edi. Endi indeks faqat FAOL qatorlar uchun:
 * `WHERE is_deleted = false` — bir xil nomli ikkita faol mahsulot hamon 409,
 * o'chirilganlar esa yonma-yon yashay oladi.
 *
 * XAVFSIZLIK (prod'da yiqilmasligi uchun):
 *   - `(name, user_id)` ustidagi HAR QANDAY to'liq (partial bo'lmagan) unique
 *     indeks/cheklov topilib o'chiriladi — baseline nomi
 *     `IDX_products_name_user_id` ham, ehtimoliy TypeORM xesh nomi ham;
 *   - yangi indeks yaratishdan OLDIN faol dublikatlar tekshiriladi. To'liq
 *     unique indeks bor ekan dublikat bo'lishi mumkin emas; agar indeks
 *     umuman bo'lmagan va faol dublikatlar bor bo'lsa — migratsiya YIQILMAYDI:
 *     WARNING yoziladi va unique indeks yaratilmaydi (holat migratsiyadan
 *     oldingidek: cheklovsiz). Dublikatlar qo'lda tozalangach, migratsiyani
 *     `down` + `up` bilan qayta yurgizish kifoya.
 *   - jadval yo'q muhitda (yangi baza) hech narsa qilmaydi.
 *
 * `down()`: partial indeks o'chiriladi va to'liq indeks qaytariladi. Agar
 * o'chirilgan qatorlar tufayli to'liq dublikatlar paydo bo'lgan bo'lsa,
 * to'liq indeksni yaratib bo'lmaydi — WARNING bilan partial indeks qayta
 * tiklanadi (faol qatorlar himoyasi yo'qolmasin).
 */
export class ProductNameUniqueActiveOnly1716000000087 implements MigrationInterface {
  name = 'ProductNameUniqueActiveOnly1716000000087';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        tbl oid := to_regclass('catalog_schema.products');
        rec record;
        dup_count integer;
      BEGIN
        IF tbl IS NULL THEN
          RETURN;
        END IF;

        -- (name, user_id) ustidagi to'liq unique indeks/cheklovlar.
        FOR rec IN
          SELECT ic.relname AS index_name, con.conname AS constraint_name
            FROM pg_index i
            JOIN pg_class ic ON ic.oid = i.indexrelid
            LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
           WHERE i.indrelid = tbl
             AND i.indisunique
             AND NOT i.indisprimary
             AND i.indpred IS NULL
             AND (
               SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                 FROM unnest(i.indkey::int2[]) AS k(attnum)
                 JOIN pg_attribute a
                   ON a.attrelid = tbl AND a.attnum = k.attnum
             ) = ARRAY['name', 'user_id']
        LOOP
          IF rec.constraint_name IS NOT NULL THEN
            EXECUTE format(
              'ALTER TABLE catalog_schema.products DROP CONSTRAINT %I',
              rec.constraint_name
            );
          ELSE
            EXECUTE format(
              'DROP INDEX catalog_schema.%I',
              rec.index_name
            );
          END IF;
        END LOOP;

        -- Ayni nomli eski (partial) indeks qolgan bo'lsa — qayta yaratamiz.
        DROP INDEX IF EXISTS catalog_schema."IDX_products_name_user_id";

        SELECT count(*) INTO dup_count
          FROM (
            SELECT 1
              FROM catalog_schema.products
             WHERE is_deleted = false
             GROUP BY name, user_id
            HAVING count(*) > 1
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING
            'As75bkGo: catalog_schema.products da % ta faol (name, user_id) dublikat guruhi bor — unique indeks YARATILMADI. Dublikatlarni tozalab, migratsiyani qayta yurgizing.',
            dup_count;
          RETURN;
        END IF;

        CREATE UNIQUE INDEX "IDX_products_name_user_id"
          ON catalog_schema.products ("name", "user_id")
          WHERE "is_deleted" = false;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        dup_count integer;
      BEGIN
        IF to_regclass('catalog_schema.products') IS NULL THEN
          RETURN;
        END IF;

        DROP INDEX IF EXISTS catalog_schema."IDX_products_name_user_id";

        SELECT count(*) INTO dup_count
          FROM (
            SELECT 1
              FROM catalog_schema.products
             GROUP BY name, user_id
            HAVING count(*) > 1
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING
            'As75bkGo down: % ta (name, user_id) dublikat guruhi (o''chirilgan qatorlar bilan) — to''liq unique indeks yaratib bo''lmaydi, partial indeks qoldirildi.',
            dup_count;
          CREATE UNIQUE INDEX "IDX_products_name_user_id"
            ON catalog_schema.products ("name", "user_id")
            WHERE "is_deleted" = false;
          RETURN;
        END IF;

        CREATE UNIQUE INDEX "IDX_products_name_user_id"
          ON catalog_schema.products ("name", "user_id");
      END
      $$;
    `);
  }
}
