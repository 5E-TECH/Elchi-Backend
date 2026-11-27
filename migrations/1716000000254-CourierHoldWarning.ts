import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * onXzDc5n — KURYERDAGI BUYURTMALAR (72 soatdan oshgan, 48 soatga yaqin,
 * kuryerlar bo'yicha) va 36 soatlik ogohlantirish.
 *
 * order_schema.orders (NULL, sukutsiz — jadval qayta yozilmaydi):
 *   - `courier_hold_warned_at` timestamptz — «48 soatga yaqinlashdi»
 *     ogohlantirishi (kuryer + market) ketgan payt. Takror yubormaslik
 *     belgisi: `courier_hold_warned_at >= last_handover_at` — shu kuryerga
 *     topshirishda ogohlantirish ketgan (boshqa kuryerga o'tsa — yana bir marta);
 *   - qism indeks `IDX_orders_courier_hold` (`last_handover_at`) WHERE
 *     holder_type = 'COURIER' va holat «Yo'lda» / «Kutilmoqda» / «Mijoz
 *     kutilmoqda» — ro'yxatlar, kuryer jamlamasi va cron skani faqat kuryer
 *     qo'lidagi buyurtmalarni o'qiydi.
 *
 * BACKFILL YO'Q: eski buyurtmalar NULL. Cron faqat 36 ≤ soat < 48 oralig'idagi
 * buyurtmalarga xabar beradi — yoqilgan paytda 48 dan oshib ketganlarga
 * «yaqinlashdi» xabari ketmaydi (ular ro'yxatlarda ko'rinadi).
 *
 * down(): indeks va ustun o'chiriladi.
 *
 * Sxema nomi konstruktorda (sukut `order_schema`) — pg spec alohida sxemada
 * yurgizadi.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class CourierHoldWarning1716000000254 implements MigrationInterface {
  name = 'CourierHoldWarning1716000000254';

  private readonly order: string;

  constructor(orderSchema = 'order_schema') {
    if (!SCHEMA_NAME.test(orderSchema)) {
      throw new Error('CourierHoldWarning1716000000254: noto‘g‘ri sxema nomi');
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
          ADD COLUMN IF NOT EXISTS "courier_hold_warned_at" TIMESTAMPTZ NULL;
        CREATE INDEX IF NOT EXISTS "IDX_orders_courier_hold"
          ON "${o}"."orders" ("last_handover_at")
          WHERE "holder_type" = 'COURIER'
            AND "status" IN ('on the road', 'waiting', 'waiting_customer')
            AND "is_deleted" = false;
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
        DROP INDEX IF EXISTS "${o}"."IDX_orders_courier_hold";
        ALTER TABLE "${o}"."orders"
          DROP COLUMN IF EXISTS "courier_hold_warned_at";
      END
      $$
    `);
  }
}
