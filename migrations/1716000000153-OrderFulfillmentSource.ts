import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6kHnNH9j — ombor ↔ buyurtma oqimi (ega qarorlari 2026-10-23/24).
 *
 * order_schema.orders:
 *   - `fulfillment_source` varchar(16) NOT NULL DEFAULT 'HQ' — buyurtma
 *     qayerdan ketadi: `HQ` (hozirgi oqim — market posilkani HQ'ga olib
 *     keladi) yoki `WAREHOUSE` (viloyat filiali omboridan, catalog-service
 *     `stock_reservations` bandi bilan). CHECK — faqat shu ikki qiymat;
 *   - `warehouse_id` bigint NULL — catalog `warehouses.id` (boshqa sxema —
 *     FK yo'q). CHECK: `WAREHOUSE` ⇔ `warehouse_id` bor;
 *   - partial indeks `IDX_orders_warehouse_id` (faqat ombor buyurtmalari) —
 *     `GET /orders?fulfillment_source=WAREHOUSE` va ombor bo'yicha qidiruv.
 *
 * XAVFSIZLIK: eski buyurtmalar — HQ (sukutli ustun, PG 11+ da jadval qayta
 * yozilmaydi; `warehouse_id` NULL). Hammasi `IF NOT EXISTS` / mavjudlik
 * tekshiruvi bilan — qayta yurgizish xatosiz; `orders` yo'q muhitda
 * o'tkazib yuboriladi.
 *
 * down(): ustunlar o'chiriladi — qaysi buyurtma ombordan ketgani yo'qoladi
 * (catalog'dagi band/harakatlar saqlanadi, `ref_id` = buyurtma id).
 *
 * Sxema nomi konstruktorda (sukut `order_schema`) — pg spec alohida sxemada.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class OrderFulfillmentSource1716000000153 implements MigrationInterface {
  name = 'OrderFulfillmentSource1716000000153';

  private readonly order: string;

  constructor(orderSchema = 'order_schema') {
    if (!SCHEMA_NAME.test(orderSchema)) {
      throw new Error(
        'OrderFulfillmentSource1716000000153: noto‘g‘ri sxema nomi',
      );
    }
    this.order = orderSchema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const o = this.order;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${o}"."orders"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${o}"."orders"
          ADD COLUMN IF NOT EXISTS "fulfillment_source" character varying(16)
          NOT NULL DEFAULT 'HQ';
        ALTER TABLE "${o}"."orders"
          ADD COLUMN IF NOT EXISTS "warehouse_id" bigint NULL;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_orders_fulfillment_source'
             AND conrelid = '"${o}"."orders"'::regclass
        ) THEN
          ALTER TABLE "${o}"."orders"
            ADD CONSTRAINT "CHK_orders_fulfillment_source"
            CHECK ("fulfillment_source" IN ('HQ', 'WAREHOUSE'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_orders_fulfillment_warehouse'
             AND conrelid = '"${o}"."orders"'::regclass
        ) THEN
          ALTER TABLE "${o}"."orders"
            ADD CONSTRAINT "CHK_orders_fulfillment_warehouse"
            CHECK (("fulfillment_source" = 'WAREHOUSE') = ("warehouse_id" IS NOT NULL));
        END IF;
        CREATE INDEX IF NOT EXISTS "IDX_orders_warehouse_id"
          ON "${o}"."orders" ("warehouse_id")
          WHERE "warehouse_id" IS NOT NULL;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const o = this.order;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${o}"."orders"') IS NULL THEN
          RETURN;
        END IF;
        DROP INDEX IF EXISTS "${o}"."IDX_orders_warehouse_id";
        ALTER TABLE "${o}"."orders"
          DROP CONSTRAINT IF EXISTS "CHK_orders_fulfillment_warehouse";
        ALTER TABLE "${o}"."orders"
          DROP CONSTRAINT IF EXISTS "CHK_orders_fulfillment_source";
        ALTER TABLE "${o}"."orders" DROP COLUMN IF EXISTS "warehouse_id";
        ALTER TABLE "${o}"."orders" DROP COLUMN IF EXISTS "fulfillment_source";
      END
      $$
    `);
  }
}
