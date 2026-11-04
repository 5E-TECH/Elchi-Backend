import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Market sozlamasi (`identity_schema.admins`, market qatorlari):
 * `cashbox_debt_enabled` — market kassasi qarzga ishlaydimi.
 *
 * FALSE (sukut, avvalgi xulq): marketga to'lov qarzdan oshsa — 400
 * («To'lov miqdori marketga qarzdan oshib ketdi»). TRUE — admin/superadmin
 * yoqqan market uchun ortiqcha to'lov o'tadi, market kassasi manfiyga
 * tushadi (market bizga qarzdor; ortig'i `hq_to_market` qoldig'i bo'lib
 * keyingi buyurtmalarga hisoblanadi).
 *
 * Hamma market uchun — mavjudlari ham — o'chiq: Postgres 11+ da `DEFAULT
 * false` faqat katalog o'zgarishi, backfill UPDATE yo'q. `IF NOT EXISTS` —
 * qayta yurgizish xatosiz.
 */
export class MarketCashboxDebtEnabled1716000000207 implements MigrationInterface {
  name = 'MarketCashboxDebtEnabled1716000000207';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "cashbox_debt_enabled" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "cashbox_debt_enabled"
    `);
  }
}
