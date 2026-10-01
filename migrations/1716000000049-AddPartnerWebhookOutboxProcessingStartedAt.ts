import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `partner_webhook_outbox.processing_started_at` — qator `processing`ga claim
 * qilingan vaqt (sY4BsVGH).
 *
 * NEGA KERAK. Claim (`pending`→`processing`) bilan HTTP yetkazish natijasi
 * orasida jarayon KRASH bo'lsa, qator abadiy `processing`da qolardi: scheduler
 * faqat `pending` qatorlarni tanlagani uchun u hech qachon qayta urinilmasdi,
 * va qisman unique indeks (`status IN ('pending','processing')`) tufayli o'sha
 * (partner, order, status) juftligi uchun yangi webhook ham yozib bo'lmasdi.
 * Bu ustun reaper'ga eskirgan claim'ni aniqlab, qatorni `pending`ga
 * qaytarishga imkon beradi.
 *
 * ⚠️ `null` sukut — mavjud qatorlar uchun ma'no yo'q (ular hozir `processing`da
 * emas); migratsiyadan oldin qotib qolgan legacy `processing` qatorlar ham
 * `null` bo'lib qoladi va reaper ularni (null = eskirgan deb) tiklaydi.
 */
export class AddPartnerWebhookOutboxProcessingStartedAt1716000000049
  implements MigrationInterface
{
  name = 'AddPartnerWebhookOutboxProcessingStartedAt1716000000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partner_webhook_outbox"
        ADD COLUMN IF NOT EXISTS "processing_started_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."partner_webhook_outbox"
        DROP COLUMN IF EXISTS "processing_started_at"
    `);
  }
}
