import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manfiy summa / miqdorli eski buyurtmalarni tozalash (IDG1z5y9).
 *
 * Kod endi `total_price < 0` va `quantity < 1` ni rad etadi (gateway DTO +
 * order-lifecycle `assertCreateAmounts`). Bu migratsiya ilgari yozilib qolgan
 * qatorlarni topadi (`total_price < 0 OR product_quantity < 0`):
 *
 * - Hali pul oqimiga kirmagan holatdagilar (`created`, `new`) — xuddi
 *   `DELETE /orders/:id` kabi soft-delete (`is_deleted = true`) qilinadi.
 * - Boshqa holatdagilarga (qabul qilingan, kuryerda, sotilgan, …) TEGILMAYDI:
 *   ularda kassa/settlement yozuvlari bo'lishi mumkin, avtomatik o'chirish
 *   moliyani yana buzadi. Ular deploy logiga NOTICE bilan chiqariladi — qo'lda
 *   ko'rib chiqilsin.
 *
 * O'chirilgan qatorlar `order_schema.cleanup_negative_orders_061` ga
 * yoziladi — `down()` aynan shularni tiklaydi (qidiruv indeksiga keyingi
 * tahrirda qaytadi). Qidiruvdan olib tashlash `DELETE /orders/:id` dagi kabi
 * outbox orqali.
 */
export class CleanupNegativeOrderAmounts1716000000061 implements MigrationInterface {
  name = 'CleanupNegativeOrderAmounts1716000000061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_schema"."cleanup_negative_orders_061" (
        "order_id" bigint PRIMARY KEY,
        "status" varchar NOT NULL,
        "total_price" numeric(14,2),
        "product_quantity" integer,
        "cleaned_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      WITH cleaned AS (
        UPDATE "order_schema"."orders" o
           SET "is_deleted" = true
         WHERE o."is_deleted" = false
           AND o."status" IN ('created', 'new')
           AND (o."total_price" < 0 OR o."product_quantity" < 0)
        RETURNING o."id", o."status", o."total_price", o."product_quantity"
      )
      , saved AS (
        INSERT INTO "order_schema"."cleanup_negative_orders_061"
          ("order_id", "status", "total_price", "product_quantity")
        SELECT "id", "status"::varchar, "total_price", "product_quantity"
          FROM cleaned
        ON CONFLICT ("order_id") DO NOTHING
        RETURNING "order_id"
      )
      -- DELETE /orders/:id bilan bir xil: qidiruv indeksidan ham olinadi
      -- (removeOrderFromSearch → outbox SEARCH / search.index.remove).
      INSERT INTO "order_schema"."outbox_events"
        ("target", "pattern", "payload", "status", "attempts", "scheduled_at")
      SELECT 'SEARCH',
             'search.index.remove',
             jsonb_build_object(
               'source', 'order',
               'type', 'order',
               'sourceId', "order_id"::text,
               'request_id', gen_random_uuid()::text
             ),
             'pending',
             0,
             now()
        FROM saved
    `);

    // Pul oqimiga kirganlar — faqat xabar, o'zgartirish YO'Q.
    await queryRunner.query(`
      DO $$
      DECLARE
        ids text;
        cnt integer;
      BEGIN
        SELECT count(*), string_agg(o."id"::text, ', ' ORDER BY o."id")
          INTO cnt, ids
          FROM "order_schema"."orders" o
         WHERE o."is_deleted" = false
           AND (o."total_price" < 0 OR o."product_quantity" < 0);
        IF cnt > 0 THEN
          RAISE NOTICE 'IDG1z5y9: % ta manfiy buyurtma pul oqimida — qo''lda ko''rib chiqing: %', cnt, ids;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "order_schema"."orders" o
         SET "is_deleted" = false
        FROM "order_schema"."cleanup_negative_orders_061" c
       WHERE o."id" = c."order_id"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_schema"."cleanup_negative_orders_061"`,
    );
  }
}
