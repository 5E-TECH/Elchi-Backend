import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `orders(qr_code_token)` — skaner qidiruvi uchun (Andijon E2E, D148eHMA).
 *
 * MUAMMO. `GET /scan/:token`, `receive-by-scan` va skanerlab biriktirish
 * yorliq tokeni bo'yicha `orders` ni izlaydi, lekin bu ustunda INDEKS YO'Q
 * edi — har skan jadvalni to'liq skanerlardi (prod: median 0.40s, max 0.65s,
 * ombor operatori esa sekundiga 1–2 yorliq skanerlaydi).
 *
 * ⚠️ UNIQUE EMAS: eski ma'lumotda takroriy yoki bo'sh token bo'lishi mumkin
 * va `UNIQUE` migratsiya deploy'ni yiqitardi. `WHERE ... IS NOT NULL` —
 * qismiy indeks, tokensiz qatorlar unga tushmaydi.
 *
 * `CONCURRENTLY` ISHLATILMAYDI (1716000000035 bilan bir xil sabab): TypeORM
 * migratsiyasi tranzaksiyada bajariladi. Katta jadvalda qisqa qulflanish —
 * deploy oynasida hisobga olinsin.
 */
export class OrderQrCodeTokenIndex1716000000058 implements MigrationInterface {
  name = 'OrderQrCodeTokenIndex1716000000058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ORDER_QR_CODE_TOKEN"
        ON "order_schema"."orders" ("qr_code_token")
        WHERE "qr_code_token" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "order_schema"."IDX_ORDER_QR_CODE_TOKEN"
    `);
  }
}
