import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T0UGh8bL — `orders.sale_market_paid_amount`: sotuvda sotuvchi (kuryer yoki
 * menejer sotuvida filial) marketga TO'G'RIDAN-TO'G'RI bergan naqd snapshoti.
 *
 * `sell {paidAmount: X}` endi qabul qilinadi (ZsPLevZZ (a) yo'li): sotuv
 * tranzaksiyasida market va sotuvchi kassasidan X yechiladi, settlement
 * oyoqlari X ga kamayadi. Rollback o'sha X oyoqlarini AYNAN teskari yozishi
 * uchun summa shu ustunda saqlanadi — `paid_amount` dan uni ajratib bo'lmaydi
 * (autoPay va HQ to'lovlari ham unga qo'shiladi).
 *
 * `NULL` — X siz yoki ustundan oldin sotilgan buyurtma (0 bilan bir xil).
 * Shu bois `DEFAULT` ham, backfill ham kerak emas; `ADD COLUMN` (NULL,
 * defaultsiz) — Postgres'da faqat katalog o'zgarishi, jadval qayta
 * yozilmaydi. `IF NOT EXISTS` — qayta ishga tushirish xavfsiz.
 */
export class OrderSaleMarketPaidAmount1716000000099 implements MigrationInterface {
  name = 'OrderSaleMarketPaidAmount1716000000099';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "sale_market_paid_amount" numeric(14,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "sale_market_paid_amount"
    `);
  }
}
