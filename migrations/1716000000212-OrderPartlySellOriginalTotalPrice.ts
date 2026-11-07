import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders.partly_sell_original_total_price` — narx tushirib qisman sotuvdan
 * OLDINGI buyurtma summasi (ega 2026-11-07, BeePost'dagidek).
 *
 * Kuryer yoki menejer mahsulot sonini kamaytirmasdan faqat narxni tushirib
 * sotsa (500 000 → 350 000), bekor qilingan «bola» buyurtma ochilmaydi. Rollback
 * esa asl summani hozirgacha FAQAT bolaning `total_price` idan qaytarardi —
 * bola yo'q bo'lsa 500 000 yo'qolardi. Shu sababli asl summa shu ustunda
 * saqlanadi; rollback uni `total_price` ga qaytaradi va ustunni tozalaydi.
 *
 * `NULL` — narx tushirilmagan (oddiy yoki mahsuloti kamaygan qisman sotuv).
 * Shu bois `DEFAULT` ham, backfill ham kerak emas; `ADD COLUMN` (NULL,
 * defaultsiz) — Postgres'da faqat katalog o'zgarishi, jadval qayta
 * yozilmaydi. `IF NOT EXISTS` — qayta ishga tushirish xavfsiz.
 */
export class OrderPartlySellOriginalTotalPrice1716000000212 implements MigrationInterface {
  name = 'OrderPartlySellOriginalTotalPrice1716000000212';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "partly_sell_original_total_price" numeric(14,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "partly_sell_original_total_price"
    `);
  }
}
