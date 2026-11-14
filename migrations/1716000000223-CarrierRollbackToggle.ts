import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carrier API — `rollback` ruxsati (egasi, 2026-11-14): kompaniya yuborgan
 * natijani (sold / cancelled → waiting) o'zi qaytara oladimi — har akkaunt
 * uchun admin BITTA toggle bilan yoqadi.
 *
 *  - `rollback_enabled` FALSE (sukut, hamma akkaunt — mavjudlari ham): kompaniya
 *    bilan endi ishlay boshladik, ishonch paydo bo'lguncha `status: rollback`
 *    noma'lum qiymat kabi 400 bilan rad etiladi va hujjatda ko'rsatilmaydi.
 *  - TRUE — avvalgi xulq (`order.rollback_waiting`).
 *
 * Postgres 11+ da `DEFAULT false` faqat katalog o'zgarishi, backfill UPDATE
 * yo'q. `IF NOT EXISTS` — qayta yurgizish xatosiz. Ichki qo'llanma:
 * `docs/ops/carrier-rollback.md`.
 */
export class CarrierRollbackToggle1716000000223 implements MigrationInterface {
  name = 'CarrierRollbackToggle1716000000223';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."carrier_accounts"
        ADD COLUMN IF NOT EXISTS "rollback_enabled" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."carrier_accounts"
        DROP COLUMN IF EXISTS "rollback_enabled"
    `);
  }
}
