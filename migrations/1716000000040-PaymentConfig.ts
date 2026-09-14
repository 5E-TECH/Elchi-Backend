import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `external_integrations.payment_config` — onlayn to'lov sozlamasi.
 *
 * NEGA KERAK. `role='payment'` bazaga yozilardi, lekin undan keyin hech
 * qayerda o'qilmasdi — mavjud yo'llar uni aktiv rad etardi (posilka yo'li
 * `role !== 'carrier'`, buyurtma yo'li `role !== 'source'`). To'lov hodisasi
 * imzo tekshiruvidan o'tib, keyin jimgina yo'qolardi (audit P1/P2).
 *
 * `NULL` bo'lib qo'shiladi — mavjud ulanishlarning xatti-harakati
 * O'ZGARMAYDI.
 */
export class PaymentConfig1716000000040 implements MigrationInterface {
  name = 'PaymentConfig1716000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "payment_config" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "payment_config"
    `);
  }
}
