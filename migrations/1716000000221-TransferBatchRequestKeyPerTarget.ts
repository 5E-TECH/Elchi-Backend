import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial / qaytarish paketi: `request_key` yagonaligi — so'rov + manzil +
 * viloyat (Dilshod 2026-11-14, staging).
 *
 * XATO. Filial menejeri 5 ta viloyatdagi 5 ta yangi buyurtmani «Qabul
 * qilish» qildi → `POST branches/transfer-batches` 502, ekranda «Internet
 * aloqasi yo'q». Bitta so'rov har VILOYATga (qaytarish paketi — har MANZIL
 * filialiga) alohida paket yaratadi va ularning hammasi so'rovning
 * `request_key` ini oladi. `UNIQUE (source_branch_id, request_key)` (1713203000000)
 * esa ikkinchi YANGI paketda 23505 berardi. Bitta viloyat (yoki faqat bittasi
 * yangi, qolgani mavjud PENDING paketga qo'shilsa) ishlardi — shuning uchun
 * «oz bo'lsa ishlaydi» ko'rinardi.
 *
 * YECHIM. Yagonalik `(source_branch_id, request_key, destination_branch_id,
 * target_region_id)`: bir so'rovda bir manzil+viloyatga bitta paket (kod ham
 * shunday guruhlaydi), parallel takroriy so'rov esa avvalgidek 23505 bilan
 * to'xtaydi. Idempotent qayta so'rov `source + request_key` bo'yicha qidiradi
 * — yangi indeksning boshi shu ikki ustun.
 *
 * Mavjud qatorlar eski (torroq) cheklovni qanoatlantirgan — kengrog'ini ham
 * qanoatlantiradi, ma'lumot o'zgarmaydi. Cheklov (1713203000000 —
 * CONSTRAINT) va entity sinxroni (INDEX) ikkalasi ham o'chiriladi.
 */
export class TransferBatchRequestKeyPerTarget1716000000221 implements MigrationInterface {
  name = 'TransferBatchRequestKeyPerTarget1716000000221';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."branch_transfer_batches"
        DROP CONSTRAINT IF EXISTS "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET"
        ON "order_schema"."branch_transfer_batches"
        ("source_branch_id", "request_key", "destination_branch_id", "target_region_id")
    `);
  }

  /**
   * ⚠️ Bir so'rovda bir necha paket yaratilgan bo'lsa (shu migratsiyadan
   * keyin oddiy holat) eski cheklov qaytmaydi — 23505. Ularni qo'lda hal
   * qilmasdan orqaga qaytarib bo'lmaydi.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."UQ_BRANCH_TRANSFER_BATCHES_REQUEST_TARGET"
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."branch_transfer_batches"
        ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
        UNIQUE ("source_branch_id", "request_key")
    `);
  }
}
