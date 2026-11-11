import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filial sozlamasi (`branch_schema.branches`): `cashbox_debt_enabled` —
 * filial kassasi qarzga ishlaydimi (2026-11-11, BeePost kuryer o'tkazmasi
 * kabi).
 *
 * FALSE (sukut, avvalgi xulq): HQ filialdan kassasidagi pulidan ortiq qabul
 * qila olmaydi — 400 («yetarli mablag' yo'q»). TRUE — admin/superadmin yoqqan
 * filialdan ortiqcha qabul o'tadi: filial kassasi manfiyga tushadi, ortig'i
 * `branch_to_hq` qoldig'i (carry) bo'lib qoladi — HQ filialga qarzdor
 * («HQ qarzi»), keyingi sotuvlar uni o'zi yopadi.
 *
 * Hamma filial uchun — mavjudlari ham — o'chiq: Postgres 11+ da `DEFAULT
 * false` faqat katalog o'zgarishi, backfill UPDATE yo'q. `IF NOT EXISTS` —
 * qayta yurgizish xatosiz.
 */
export class BranchCashboxDebt1716000000217 implements MigrationInterface {
  name = 'BranchCashboxDebt1716000000217';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "branch_schema"."branches"
        ADD COLUMN IF NOT EXISTS "cashbox_debt_enabled" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "branch_schema"."branches"
        DROP COLUMN IF EXISTS "cashbox_debt_enabled"
    `);
  }
}
