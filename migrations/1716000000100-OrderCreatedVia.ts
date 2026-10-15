import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Celz3rKJ — `orders.created_via`: buyurtma qaysi kanal orqali yaratilgani
 * ("AI xarajat" paneli buyurtma manbasidagi AI / qo'lda / BOT nisbati).
 *
 * Hozircha yagona qiymat `'bot'` (Telegram bot WebApp yo'li,
 * `POST /orders/telegram/bot/create`). `NULL` — qolgan barcha kanallar va
 * ustundan oldin yaratilgan buyurtmalar.
 *
 * Backfill YO'Q: eski bot buyurtmalarini boshqa market-operator
 * buyurtmalaridan ishonchli ajratib bo'lmaydi (ikkalasi ham `operator_id`
 * li `internal`). `ADD COLUMN` (NULL, defaultsiz) — Postgres'da faqat
 * katalog o'zgarishi, jadval qayta yozilmaydi. `IF NOT EXISTS` — qayta ishga
 * tushirish xavfsiz.
 */
export class OrderCreatedVia1716000000100 implements MigrationInterface {
  name = 'OrderCreatedVia1716000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "created_via" varchar(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "created_via"
    `);
  }
}
