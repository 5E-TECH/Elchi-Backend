import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kampaniya «Yetkazilmaganlar» fon eksporti endi .xlsx: tayyor fayl
 * `file_data` (bytea) da, turi `content_type` da. `csv` ustuni QOLADI — eski
 * tugagan eksportlar 7 kunlik muddati tugaguncha yuklab olinadi. Yangi ustunlar
 * nullable — jadval qayta yozilmaydi. Qayta yurgizish xatosiz (`IF NOT EXISTS`).
 */
export class CampaignReportExportFile1716000000250 implements MigrationInterface {
  name = 'CampaignReportExportFile1716000000250';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."campaign_report_exports"
        ADD COLUMN IF NOT EXISTS "file_data" BYTEA NULL,
        ADD COLUMN IF NOT EXISTS "content_type" VARCHAR(120) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."campaign_report_exports"
        DROP COLUMN IF EXISTS "file_data",
        DROP COLUMN IF EXISTS "content_type"
    `);
  }
}
