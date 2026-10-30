import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T8 (0OUcHZ7R) — buyurtmaning maxsus belgilari:
 * `order_schema.orders.special_categories varchar(32)[] NOT NULL DEFAULT '{}'`.
 *
 * CHECK faqat yopiq ro'yxatdagi kodlarni qabul qiladi (`OrderSpecialCategory`,
 * libs/common/enums). Ro'yxat kengaysa — yangi migratsiyada CHECK qayta
 * yaratiladi. Indeks yo'q: belgi bo'yicha filtr hozircha talab qilinmagan.
 *
 * XAVFSIZLIK: PULGA HAM, HOLATGA HAM TEGMAYDI. Mavjud qatorlar `'{}'` oladi.
 * `IF NOT EXISTS` — qayta yurgizish xatosiz.
 *
 * QULF: `ADD COLUMN … NOT NULL DEFAULT '{}'` (doimiy sukut) — PG 11+ da faqat
 * metama'lumot, jadval qayta yozilmaydi. CHECK `NOT VALID` bilan — mavjud
 * qatorlar skanerlanmaydi (hammasi `'{}'`, ya'ni baribir to'g'ri), yangi va
 * o'zgargan qatorlar tekshiriladi. `VALIDATE CONSTRAINT` kerak bo'lsa keyin
 * alohida (SHARE UPDATE EXCLUSIVE — yozuvni to'smaydi). `lock_timeout` 5 s:
 * band jadvalda ACCESS EXCLUSIVE navbatida cheksiz kutib, butun trafikni
 * to'xtatib qo'ymasin — deploy xato bilan to'xtaydi va qayta yurgiziladi.
 * Sozlama faqat shu blokda (oxirida avvalgisi tiklanadi): TypeORM barcha
 * migratsiyalarni bitta tranzaksiyada yurgizadi.
 *
 * down(): CHECK va ustun o'chiriladi — qo'yilgan belgilar yo'qoladi
 * (order_tracking / jurnaldagi tarix qoladi).
 */
export class OrderSpecialCategories1716000000187 implements MigrationInterface {
  name = 'OrderSpecialCategories1716000000187';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('order_schema.orders') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "order_schema"."orders"
          ADD COLUMN IF NOT EXISTS "special_categories" VARCHAR(32)[] NOT NULL DEFAULT '{}';
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_orders_special_categories'
            AND conrelid = 'order_schema.orders'::regclass
        ) THEN
          ALTER TABLE "order_schema"."orders"
            ADD CONSTRAINT "CHK_orders_special_categories"
            CHECK ("special_categories" <@ ARRAY[
              'fragile', 'religious_book', 'liquid', 'perishable',
              'battery', 'heavy', 'documents'
            ]::varchar[]) NOT VALID;
        END IF;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
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
          DROP CONSTRAINT IF EXISTS "CHK_orders_special_categories";
        ALTER TABLE "order_schema"."orders"
          DROP COLUMN IF EXISTS "special_categories";
      END
      $$
    `);
  }
}
