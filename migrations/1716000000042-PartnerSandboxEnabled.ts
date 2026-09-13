import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `partners.sandbox_enabled` — sandbox rejimining ANIQ kaliti.
 *
 * NEGA KERAK. Ilgari sandbox'ni yoqish/o'chirish degan tushuncha yo'q edi:
 * yagona boshqaruv `sandbox_webhook_url` ni yozish yoki O'CHIRIB TASHLASH
 * bo'lgan. Operator sinovni vaqtincha to'xtatmoqchi bo'lsa manzilni
 * o'chirishi, keyin qaytadan yozishi kerak edi.
 *
 * ⚠️ SUKUT `false` — mavjud hamkorlarda manzil bor bo'lsa ham sandbox
 * JIMGINA yoqilib qolmasligi kerak. Aks holda deploy'dan keyin sinov
 * muhitlariga kutilmaganda haqiqiy hodisalar oqib ketardi.
 */
export class PartnerSandboxEnabled1716000000042 implements MigrationInterface {
  name = 'PartnerSandboxEnabled1716000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partners"
        ADD COLUMN IF NOT EXISTS "sandbox_enabled" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partners"
        DROP COLUMN IF EXISTS "sandbox_enabled"
    `);
  }
}
