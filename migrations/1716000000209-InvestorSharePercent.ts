import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Investor «Ulush (%)» (BeePost «Foydalanuvchi qo'shish → Investor» kabi):
 * `investor_schema.investors.share_percent` — 0..100, NULL — kiritilmagan.
 * Mavjud investorlar NULL qoladi (backfill yo'q). `IF NOT EXISTS` — qayta
 * yurgizish xatosiz.
 */
export class InvestorSharePercent1716000000209 implements MigrationInterface {
  name = 'InvestorSharePercent1716000000209';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "investor_schema"."investors"
        ADD COLUMN IF NOT EXISTS "share_percent" NUMERIC(5,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "investor_schema"."investors"
        DROP COLUMN IF EXISTS "share_percent"
    `);
  }
}
