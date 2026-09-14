import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ikki audit tuzatishi uchun sxema o'zgarishi.
 *
 * 1. `financial_balance_history.dedup_key` (audit M4).
 *    P&L daftari `(source_type, order_id)` bo'yicha YAGONA indeks bilan
 *    himoyalangan edi. Bu takroriy yetkazishni to'g'ri to'sardi, lekin ayni
 *    paytda BITTA buyurtma uchun ikkinchi yozuvni umuman imkonsiz qilardi:
 *    sotuv → rollback → qayta sotuv zanjirida birinchi `sell_profit` abadiy
 *    qolib ketardi (rollback uni qaytarmasdi), qayta sotuvning foydasi esa
 *    jimgina o'tkazib yuborilardi. Endi kalitga `dedup_key` qo'shiladi: har
 *    urinish o'z tokeni bilan keladi, takroriy yetkazish esa ayni token bilan
 *    kelgani uchun baribir bir marta yoziladi.
 *
 *    Mavjud qatorlar `''` (bo'sh token) oladi — ya'ni eski yozuvlar avvalgidek
 *    (source_type, order_id) juftligi bo'yicha yagona bo'lib qoladi.
 *
 * 2. `shifts.cashbox_user_id` (audit M7).
 *    Smena yopilganda kirim/chiqim BUTUN kompaniya bo'yicha hisoblanardi —
 *    kassa filtri yo'q edi. Natijada operator sanab topshirgan naqdni tizim
 *    raqami bilan solishtirib bo'lmasdi, ya'ni kamomadni aniqlaydigan nazorat
 *    ishlamasdi. Endi smena qaysi kassaga tegishli ekani aniq yoziladi
 *    (sukut bo'yicha markaziy MAIN kassa, uning `user_id` = '0').
 */
export class LedgerDedupAndShiftScope1716000000043
  implements MigrationInterface
{
  name = 'LedgerDedupAndShiftScope1716000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."financial_balance_history"
        ADD COLUMN IF NOT EXISTS "dedup_key" character varying NOT NULL DEFAULT ''
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_FBH_SOURCE_ORDER"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FBH_SOURCE_ORDER_KEY"
      ON "finance_schema"."financial_balance_history"
        ("source_type", "order_id", "dedup_key")
      WHERE "order_id" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        ADD COLUMN IF NOT EXISTS "cashbox_user_id" bigint
    `);
    // Eski smenalar markaziy kassaga tegishli deb hisoblanadi — ularni
    // ochgan rollar (superadmin/admin/registrator) aynan shu kassani
    // boshqaradi.
    await queryRunner.query(`
      UPDATE "finance_schema"."shifts"
        SET "cashbox_user_id" = 0
      WHERE "cashbox_user_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        DROP COLUMN IF EXISTS "cashbox_user_id"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_FBH_SOURCE_ORDER_KEY"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FBH_SOURCE_ORDER"
      ON "finance_schema"."financial_balance_history" ("source_type", "order_id")
      WHERE "order_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."financial_balance_history"
        DROP COLUMN IF EXISTS "dedup_key"
    `);
  }
}
