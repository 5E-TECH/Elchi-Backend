import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.paid_online_amount` + `orders.payment_status` — mijozning onlayn
 * to'lovi (Uzum, Alif, Payme, Click, bank).
 *
 * ⚠️ MAVJUD MAYDONLAR BILAN ARALASHTIRMANG:
 *   `paid_amount`  — MARKET qarzining to'langan qismi (mijoz puli EMAS)
 *   `to_be_paid`   — marketga tegishli summa
 *   yangi maydon   — MIJOZ to'lov tizimi orqali to'lagan pul
 *
 * `numeric(14,2)` — `total_price` bilan bir xil. `to_be_paid`/`paid_amount`
 * eski `int` ustunlar, ya'ni tiyin saqlamaydi; yangi maydonni ham `int`
 * qilsak to'lov tizimidan kelgan tiyinli summa jimgina yumaloqlanardi.
 *
 * Ikki maydon ham xatti-harakatni O'ZGARTIRMAYDI: `paid_online_amount`
 * sukut bo'yicha 0, `payment_status` `NULL` (= onlayn to'lov bo'lmagan).
 * Sotuv oqimi ularni faqat to'lov tasdiqlangan buyurtmada o'qiydi.
 */
export class OrderOnlinePayment1716000000038 implements MigrationInterface {
  name = 'OrderOnlinePayment1716000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "paid_online_amount" numeric(14,2) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "payment_status" character varying(32)
    `);
    /**
     * Onlayn to'langan buyurtmalarni tez topish uchun — moliyaviy
     * solishtirish (reconciliation) aynan shu to'plam bo'yicha ishlaydi.
     * Qismiy indeks: ularning soni umumiy buyurtmalarga nisbatan kichik.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDER_PAYMENT_STATUS"
      ON "order_schema"."orders" ("payment_status")
      WHERE "payment_status" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDER_PAYMENT_STATUS"`,
    );
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "payment_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "paid_online_amount"
    `);
  }
}
