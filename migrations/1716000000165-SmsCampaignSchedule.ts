import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 2aS7PFX0 (N8) — SMS kampaniyani rejalashtirish (`SmsCampaignDto.scheduled_at`).
 *
 * `sms_campaigns`:
 *   - `scheduled_at`        — haqiqiy yuborish lahzasi (so'ralgan vaqt; reklama
 *                             18:00–09:00 oynasiga tushsa — oyna tugashi);
 *   - `requested_at`        — admin so'ragan lahza (surilish ko'rinsin);
 *   - `quiet_hours_shifted` — tungi taqiq sababli surilganmi;
 *   - `started_at`          — navbatga (sms_outbox) qo'yilgan lahza;
 *   - `cancelled_at/_by`    — `scheduled` holatida bekor qilingan;
 *   - `last_error`          — vaqti kelganda yuborilmagan sabab (kvota, rozilik...).
 * `status` — VARCHAR(16): 'scheduled' | 'queued' | 'failed' | 'cancelled' (CHECK yo'q,
 * avvalgidek). Rejalashtirilgan kampaniya sms_outbox'ga VAQTI KELGANDA yoziladi —
 * kunlik kvota, rozilik va opt-out o'sha kuni tekshiriladi.
 *
 * Qayta yurgizish xavfsiz (IF NOT EXISTS). Ma'lumotga tegmaydi.
 */
export class SmsCampaignSchedule1716000000165 implements MigrationInterface {
  name = 'SmsCampaignSchedule1716000000165';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."sms_campaigns"
        ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "requested_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "quiet_hours_shifted" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "cancelled_by" BIGINT NULL,
        ADD COLUMN IF NOT EXISTS "last_error" VARCHAR(300) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SMS_CAMPAIGN_SCHEDULED_DUE"
      ON "notification_schema"."sms_campaigns" ("scheduled_at")
      WHERE "status" = 'scheduled'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification_schema"."IDX_SMS_CAMPAIGN_SCHEDULED_DUE"`,
    );
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."sms_campaigns"
        DROP COLUMN IF EXISTS "last_error",
        DROP COLUMN IF EXISTS "cancelled_by",
        DROP COLUMN IF EXISTS "cancelled_at",
        DROP COLUMN IF EXISTS "started_at",
        DROP COLUMN IF EXISTS "quiet_hours_shifted",
        DROP COLUMN IF EXISTS "requested_at",
        DROP COLUMN IF EXISTS "scheduled_at"
    `);
  }
}
