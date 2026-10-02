import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `external_integrations.webhook_secret_previous_at` — webhook sekreti
 * rotatsiya oynasini YOPISH uchun vaqt belgisi (Q82QPgih).
 *
 * NEGA KERAK. Ilgari rotatsiyada eski sekret `webhook_secret_previous`da
 * MUDDATSIZ qolardi: oyna hech qachon yopilmasdi va sizib chiqqan eski sekret
 * ABADIY to'g'ri imzo berardi. Endi `receiveWebhook` eski sekretni FAQAT oyna
 * ichida (now − at <= N, sukut 24s) qabul qiladi.
 *
 * ⚠️ BACKFILL. Mavjud rotatsiyalangan qatorlarga (previous IS NOT NULL)
 * deploydan boshlab BITTA yangi oyna beramiz (now()). Shunda ularning eski
 * sekreti darhol ishdan chiqib integratsiyani sindirmaydi, lekin oyna N dan
 * keyin YOPILADI — ilgari cheksiz bo'lgan ta'sir maydoni chegaralanadi.
 */
export class AddWebhookSecretPreviousAt1716000000050
  implements MigrationInterface
{
  name = 'AddWebhookSecretPreviousAt1716000000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "webhook_secret_previous_at" timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE "integration_schema"."external_integrations"
        SET "webhook_secret_previous_at" = now()
        WHERE "webhook_secret_previous" IS NOT NULL
          AND "webhook_secret_previous_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "webhook_secret_previous_at"
    `);
  }
}
