import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * lQjt6sKP — ALMASHTIRISH (kafolat-swap) oqimi uchun sxema.
 *
 * Yangi buyurtma avval YETKAZILGAN eski buyurtma o'rniga ketadi: kuryer
 * yangisini topshirib, eskisini mijozdan qaytarib oladi. Eski buyurtma
 * SOTILGAN holatda qoladi va uning PULIGA TEGILMAYDI (reversal yo'q) — faqat
 * jismoniy qaytarish kuzatiladi.
 *
 *   replacement_of_order_id → YANGI buyurtmada: qaysi ESKI buyurtma o'rniga
 *                              (`parent_order_id` dan alohida — u qisman
 *                              sotuv bola-buyurtmasiniki).
 *   replacement_state       → awaiting_old_pickup → old_collected →
 *                              old_returned (kuryer "eskisini oldim"
 *                              darvozasi; ikkala buyurtmada ham).
 *   is_replacement_return   → ESKI buyurtmada `true` (qaytarish ro'yxati).
 *   old_item_collected_at   → kuryer eskini olgan vaqt.
 *
 * FAQAT SXEMA, BACKFILL YO'Q:
 *   - barcha ustunlar `ADD COLUMN IF NOT EXISTS`; `is_replacement_return`
 *     ning `DEFAULT false` i doimiy qiymat — Postgres 11+ da faqat katalog
 *     o'zgarishi, jadval qayta yozilmaydi;
 *   - enum tipi faqat yo'q bo'lsa yaratiladi (TypeORM nomi:
 *     `orders_replacement_state_enum`);
 *   - `UQ_ORDER_REPLACEMENT_OF` — bitta eski buyurtmaga faqat BITTA faol
 *     (`is_deleted = false`) almashtirish. Ustun yangi (hammasi NULL), shuning
 *     uchun dublikat bo'lishi mumkin emas — indeks deploy'ni yiqitmaydi.
 *     Indekslar tranzaksiyada (`CONCURRENTLY` emas — 1716000000058 bilan bir
 *     xil sabab): katta jadvalda qisqa qulflanish, deploy oynasida hisobga
 *     olinsin.
 *
 * FK yo'q (`parent_order_id` kabi): buyurtmalar soft-delete qilinadi va
 * FK qo'shish butun jadvalni tekshirib qulflardi.
 */
export class OrderReplacement1716000000111 implements MigrationInterface {
  name = 'OrderReplacement1716000000111';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'orders_replacement_state_enum'
            AND n.nspname = 'order_schema'
        ) THEN
          CREATE TYPE "order_schema"."orders_replacement_state_enum"
            AS ENUM ('awaiting_old_pickup', 'old_collected', 'old_returned');
        END IF;
      END$$;
    `);

    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "replacement_of_order_id" bigint,
        ADD COLUMN IF NOT EXISTS "replacement_state"
          "order_schema"."orders_replacement_state_enum",
        ADD COLUMN IF NOT EXISTS "is_replacement_return" boolean
          NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "old_item_collected_at" timestamptz
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ORDER_REPLACEMENT_OF"
        ON "order_schema"."orders" ("replacement_of_order_id")
        WHERE "replacement_of_order_id" IS NOT NULL AND "is_deleted" = false
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDER_REPLACEMENT_RETURN"
        ON "order_schema"."orders" ("replacement_state")
        WHERE "is_replacement_return" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_ORDER_REPLACEMENT_RETURN"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."UQ_ORDER_REPLACEMENT_OF"`,
    );
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "old_item_collected_at",
        DROP COLUMN IF EXISTS "is_replacement_return",
        DROP COLUMN IF EXISTS "replacement_state",
        DROP COLUMN IF EXISTS "replacement_of_order_id"
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "order_schema"."orders_replacement_state_enum"`,
    );
  }
}
