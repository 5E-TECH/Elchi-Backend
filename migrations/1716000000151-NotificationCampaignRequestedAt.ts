import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (fb4qy6bd) `notification_campaigns.requested_at` — admin so'ragan yuborish
 * lahzasi (belgilangan vaqt yoki darhol bo'lsa yaratilgan lahza) va
 * `quiet_hours_shifted` — reklama tungi taqiq oynasi sababli `scheduled_at`
 * surilganmi. Avval faqat yaratish javobida va activity log'da edi.
 * Mavjud qatorlar: requested_at NULL, quiet_hours_shifted false (minimal
 * variant — activity log'dan to'ldirilmadi).
 * Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
 */
export class NotificationCampaignRequestedAt1716000000151 implements MigrationInterface {
  name = 'NotificationCampaignRequestedAt1716000000151';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."notification_campaigns"
        ADD COLUMN IF NOT EXISTS "requested_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "quiet_hours_shifted" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."notification_campaigns"
        DROP COLUMN IF EXISTS "quiet_hours_shifted",
        DROP COLUMN IF EXISTS "requested_at"
    `);
  }
}
