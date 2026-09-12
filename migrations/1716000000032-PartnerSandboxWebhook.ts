import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hamkor uchun SANDBOX (sinov) webhook manzili.
 *
 * Prodakshnga chiqqandan keyin `webhook_url` haqiqiy qabul qiluvchiga
 * qaratilgan bo'ladi va unga tegib bo'lmaydi. Integratsiyani tekshirish uchun
 * esa HAQIQIY hodisalar oqimini ko'rish kerak — sinov buyurtmasi yaratmasdan.
 *
 * `sandbox_webhook_url` qo'yilsa, har bir chiquvchi hodisaning NUSXASI shu
 * manzilga ham yuboriladi (`sandbox: true` bayrog'i bilan).
 *
 * `sandbox_webhook_secret` — ixtiyoriy; berilmasa asosiy sekret ishlatiladi.
 * Ikkalasi ham AES bilan shifrlangan holda saqlanadi (sekret uchun).
 */
export class PartnerSandboxWebhook1716000000032 implements MigrationInterface {
  name = 'PartnerSandboxWebhook1716000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partners"
        ADD COLUMN IF NOT EXISTS "sandbox_webhook_url" varchar,
        ADD COLUMN IF NOT EXISTS "sandbox_webhook_secret" varchar
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partners"
        DROP COLUMN IF EXISTS "sandbox_webhook_url",
        DROP COLUMN IF EXISTS "sandbox_webhook_secret"
    `);
  }
}
