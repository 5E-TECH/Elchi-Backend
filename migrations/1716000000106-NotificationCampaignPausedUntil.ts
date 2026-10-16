import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (WIsb9Ytq) `notification_campaigns.paused_until` — reklama kampaniyasi
 * partiyasi tungi taqiq oynasiga (NOTIF_PROMO_QUIET_HOURS, sukut
 * 18:00–09:00 Toshkent) tushganda keyingi partiya outbox `scheduledAt`
 * bilan oyna tugashiga suriladi; ro'yxatda "rejalashtirilgan / 09:00 da
 * davom etadi" ko'rsatish uchun shu lahza saqlanadi.
 *
 * Faqat sxema: `ADD COLUMN IF NOT EXISTS`, NULL — mavjud qatorlarga tegilmaydi
 * (backfill yo'q). RabbitMQ navbat argumentlariga tegilmaydi.
 */
export class NotificationCampaignPausedUntil1716000000106 implements MigrationInterface {
  name = 'NotificationCampaignPausedUntil1716000000106';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."notification_campaigns" ADD COLUMN IF NOT EXISTS "paused_until" TIMESTAMPTZ NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."notification_campaigns" DROP COLUMN IF EXISTS "paused_until"`,
    );
  }
}
