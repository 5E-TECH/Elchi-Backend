import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders` ga KIRUVCHI QOP (batch) maydonlari.
 *
 * ⚠️ NEGA KERAK. Hamkor posilkalari Elchi'ga bittalab keladi va kiruvchi
 * ekranda TEKIS ro'yxat bo'lib turadi. Operator uchun ikki narsa yo'q edi:
 *
 *   1. "Nechta posilka kelayotgani" — qop bo'lib guruhlanmagan, ya'ni
 *      11 tasi yetib kelib 1 tasi yo'qolsa bu KO'RINMASDI;
 *   2. Qop ustidagi UMUMIY yorliqni skanerlab butun qopni qabul qilish —
 *      operator 12 posilkani bittalab skanerlashga majbur edi.
 *
 * Endi hamkor har posilka bilan qop ma'lumotini ham yuboradi.
 *
 * ⚠️ `external_batch_token` — QOP USTIDAGI QR. U bo'yicha qidiriladi, shu
 * bois indeks bor. Qisman indeks: faqat tashqi posilkalarda to'ladi.
 *
 * ⚠️ `external_batch_size` — hamkor AYTGAN son, biz sanagan son EMAS. Ikkisi
 * farq qilsa qop to'liq yetib kelmagan degani va buni ko'rsatish kerak.
 * Biz sanagan son bilan almashtirish bu farqni YASHIRARDI.
 *
 * Hammasi nullable, DEFAULT yo'q: eski posilkalarda qop ma'lumoti yo'q va
 * 0 bilan to'ldirish "qopda 0 posilka" degan yolg'on da'vo bo'lardi.
 */
export class OrderExternalBatch1716000000046 implements MigrationInterface {
  name = 'OrderExternalBatch1716000000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      ADD COLUMN IF NOT EXISTS "external_batch_ref" varchar,
      ADD COLUMN IF NOT EXISTS "external_batch_token" varchar,
      ADD COLUMN IF NOT EXISTS "external_batch_size" int
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDERS_EXTERNAL_BATCH_TOKEN"
      ON "order_schema"."orders" ("external_batch_token")
      WHERE "external_batch_token" IS NOT NULL AND "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_ORDERS_EXTERNAL_BATCH_TOKEN"
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
      DROP COLUMN IF EXISTS "external_batch_size",
      DROP COLUMN IF EXISTS "external_batch_token",
      DROP COLUMN IF EXISTS "external_batch_ref"
    `);
  }
}
