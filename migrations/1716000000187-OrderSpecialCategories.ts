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
 * down(): CHECK va ustun o'chiriladi — qo'yilgan belgilar yo'qoladi
 * (order_tracking / jurnaldagi tarix qoladi).
 */
export class OrderSpecialCategories1716000000187 implements MigrationInterface {
  name = 'OrderSpecialCategories1716000000187';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('order_schema.orders') IS NULL THEN
          RETURN;
        END IF;
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
            ]::varchar[]);
        END IF;
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
