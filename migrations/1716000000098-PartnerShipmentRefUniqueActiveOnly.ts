import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * yokjwjXG: o'chirilgan hamkor buyurtmasining bog'lanishini yopish.
 *
 * Superadmin pochta detalidan buyurtmani o'chirganda (`POST /post/delete`)
 * integration-service `partner_shipment_refs` qatorini soft-delete qiladi
 * (`is_deleted = true`). Lekin `(partner_id, external_order_id)` unique
 * indeksi o'chirilgan qatorlarni HAM hisobga olardi: hamkor ayni
 * `external_order_id` bilan posilkani qayta yaratganda yangi ref INSERT
 * yiqilardi (buyurtma esa allaqachon yaratilgan — yetim qolardi). Endi indeks
 * faqat FAOL qatorlar uchun: `WHERE is_deleted = false` — bir xil juftlikdagi
 * ikkita faol ref hamon taqiqlangan (idempotentlik o'zgarmaydi).
 *
 * XAVFSIZLIK (087 naqshi):
 *   - `(partner_id, external_order_id)` ustidagi HAR QANDAY to'liq (partial
 *     bo'lmagan) unique indeks/cheklov topilib o'chiriladi — 018 dagi
 *     `IDX_PSR_PARTNER_EXTERNAL` ham, ehtimoliy TypeORM xesh nomi ham;
 *   - yangi indeksdan OLDIN faol dublikatlar tekshiriladi. To'liq unique
 *     indeks bor ekan dublikat bo'lishi mumkin emas; agar bo'lsa migratsiya
 *     YIQILMAYDI — WARNING yoziladi va indeks yaratilmaydi;
 *   - jadval yo'q muhitda (yangi baza) hech narsa qilmaydi.
 *
 * `down()`: partial indeks o'chiriladi va to'liq indeks qaytariladi. Yopilgan
 * qatorlar tufayli to'liq dublikat bo'lsa — WARNING bilan partial indeks
 * qayta tiklanadi (faol qatorlar himoyasi yo'qolmasin).
 */
export class PartnerShipmentRefUniqueActiveOnly1716000000098 implements MigrationInterface {
  name = 'PartnerShipmentRefUniqueActiveOnly1716000000098';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        tbl oid := to_regclass('integration_schema.partner_shipment_refs');
        rec record;
        dup_count integer;
      BEGIN
        IF tbl IS NULL THEN
          RETURN;
        END IF;

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
             ) = ARRAY['external_order_id', 'partner_id']
        LOOP
          IF rec.constraint_name IS NOT NULL THEN
            EXECUTE format(
              'ALTER TABLE integration_schema.partner_shipment_refs DROP CONSTRAINT %I',
              rec.constraint_name
            );
          ELSE
            EXECUTE format(
              'DROP INDEX integration_schema.%I',
              rec.index_name
            );
          END IF;
        END LOOP;

        DROP INDEX IF EXISTS integration_schema."IDX_PSR_PARTNER_EXTERNAL";

        SELECT count(*) INTO dup_count
          FROM (
            SELECT 1
              FROM integration_schema.partner_shipment_refs
             WHERE is_deleted = false
             GROUP BY partner_id, external_order_id
            HAVING count(*) > 1
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING
            'yokjwjXG: integration_schema.partner_shipment_refs da % ta faol (partner_id, external_order_id) dublikat guruhi bor — unique indeks YARATILMADI. Dublikatlarni tozalab, migratsiyani qayta yurgizing.',
            dup_count;
          RETURN;
        END IF;

        CREATE UNIQUE INDEX "IDX_PSR_PARTNER_EXTERNAL"
          ON integration_schema.partner_shipment_refs ("partner_id", "external_order_id")
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
        IF to_regclass('integration_schema.partner_shipment_refs') IS NULL THEN
          RETURN;
        END IF;

        DROP INDEX IF EXISTS integration_schema."IDX_PSR_PARTNER_EXTERNAL";

        SELECT count(*) INTO dup_count
          FROM (
            SELECT 1
              FROM integration_schema.partner_shipment_refs
             GROUP BY partner_id, external_order_id
            HAVING count(*) > 1
          ) d;

        IF dup_count > 0 THEN
          RAISE WARNING
            'yokjwjXG down: % ta (partner_id, external_order_id) dublikat guruhi (yopilgan qatorlar bilan) — to''liq unique indeks yaratib bo''lmaydi, partial indeks qoldirildi.',
            dup_count;
          CREATE UNIQUE INDEX "IDX_PSR_PARTNER_EXTERNAL"
            ON integration_schema.partner_shipment_refs ("partner_id", "external_order_id")
            WHERE "is_deleted" = false;
          RETURN;
        END IF;

        CREATE UNIQUE INDEX "IDX_PSR_PARTNER_EXTERNAL"
          ON integration_schema.partner_shipment_refs ("partner_id", "external_order_id");
      END
      $$;
    `);
  }
}
