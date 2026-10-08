import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bekor qilingan buyurtmalarda soxta debitorlik (Andijon E2E, pLmAsEsj).
 *
 * `cancelOrder` ilgari `to_be_paid` ni tegmasdi — u yaratilishdagi qiymatda
 * (= total_price) qolardi va bekor qilingan buyurtma "marketga to'lanishi
 * kerak" deb turardi. Rollback yo'lidan o'tgan xuddi shunday buyurtma esa 0
 * ko'rsatardi. Kod endi bekor qilishda 0 yozadi; bu migratsiya eski qatorlarni
 * tenglashtiradi. Sotilmagan holatlar (bekor, marketga yuborilgan, marketga
 * qaytarilgan) — ularda marketga qarz yo'q. `down` yo'q: eski qiymat noto'g'ri
 * edi va qayta tiklanmaydi.
 */
export class ZeroCancelledOrdersToBePaid1716000000057 implements MigrationInterface {
  name = 'ZeroCancelledOrdersToBePaid1716000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "order_schema"."orders"
         SET "to_be_paid" = 0
       WHERE "status" IN ('cancelled', 'cancelled (sent)', 'returned_to_market')
         AND "to_be_paid" <> 0
    `);
  }

  public async down(): Promise<void> {
    // Ataylab bo'sh — qarang yuqoridagi izoh.
  }
}
