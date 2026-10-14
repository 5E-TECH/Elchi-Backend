import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (QTCUUgjA) Smena yopilishida kamomad nazorati.
 *
 * Smena yopilganda tizim kutgan qoldiq va sanab topshirilgan summa bilan
 * farqi hech qayerda hisoblanmas ham, saqlanmas ham edi — "sanab topshirilgan
 * naqdni tizim raqami bilan solishtirish" degan yagona nazorat ishlamasdi.
 *
 *  - `expected_balance_cash/card` = opening + total_income − total_expense;
 *  - `discrepancy_cash/card` = closing (sanalgan) − expected
 *    (manfiy — kamomad, musbat — ortiqcha).
 *
 * Hammasi NULL bo'la oladi: ochiq smenada, eski (migratsiyadan oldingi)
 * smenalarda va sanalgan summa yuborilmagan yopilishda qiymat yo'q — soxta
 * "0 kamomad" ko'rsatilmaydi. Mavjud qatorlar o'zgartirilmaydi.
 */
export class ShiftExpectedAndDiscrepancy1716000000078 implements MigrationInterface {
  name = 'ShiftExpectedAndDiscrepancy1716000000078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        ADD COLUMN IF NOT EXISTS "expected_balance_cash" numeric(20,2),
        ADD COLUMN IF NOT EXISTS "expected_balance_card" numeric(20,2),
        ADD COLUMN IF NOT EXISTS "discrepancy_cash" numeric(20,2),
        ADD COLUMN IF NOT EXISTS "discrepancy_card" numeric(20,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "finance_schema"."shifts"
        DROP COLUMN IF EXISTS "discrepancy_card",
        DROP COLUMN IF EXISTS "discrepancy_cash",
        DROP COLUMN IF EXISTS "expected_balance_card",
        DROP COLUMN IF EXISTS "expected_balance_cash"
    `);
  }
}
