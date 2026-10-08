import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ulanish ISH REJIMI — granular kalitlar (DOZ6dtJn).
 *
 * Ilgari ulanishda faqat `is_active` (master) bor edi: kiruvchi webhookni
 * yoki fon solishtiruvchisini ulanishni o'ldirmasdan alohida to'xtatib
 * bo'lmasdi.
 *
 *   `webhook_enabled`   — o'chiq bo'lsa kiruvchi hodisa jurnalga
 *                         `skipped_disabled` bilan yoziladi, QO'LLANMAYDI.
 *                         Chiquvchi jo'natish to'xtamaydi.
 *   `reconcile_enabled` — davriy solishtiruvchi (ochiq posilka holatini
 *                         tashuvchidan so'rash). Yo'qolgan webhook tufayli
 *                         buyurtma abadiy "kutilmoqda" da qolmasin.
 *   `last_reconcile_at` — oxirgi solishtiruv vaqti (UI va health).
 *
 * ⚠️ IKKALA KALIT HAM `DEFAULT true`: mavjud ulanishlar migratsiyadan keyin
 * avvalgidek ishlaydi — hech biri jimgina o'chib qolmaydi. Master
 * (`is_active`) baribir ustun.
 */
export class IntegrationWorkModeSwitches1716000000059 implements MigrationInterface {
  name = 'IntegrationWorkModeSwitches1716000000059';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        ADD COLUMN IF NOT EXISTS "webhook_enabled" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "reconcile_enabled" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "last_reconcile_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."external_integrations"
        DROP COLUMN IF EXISTS "last_reconcile_at",
        DROP COLUMN IF EXISTS "reconcile_enabled",
        DROP COLUMN IF EXISTS "webhook_enabled"
    `);
  }
}
