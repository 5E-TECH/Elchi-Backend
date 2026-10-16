import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (H7kpCman) `notification_schema.campaign_report_exports` — kampaniya
 * hisobotidagi "Yetkazilmaganlar" CSV eksportining fon vazifalari.
 *
 * 10 000 qatordan katta eksport sinxron bajarilmaydi: qator `queued` bilan
 * ochiladi, outbox (`notification.campaign.export.run`) fonda CSV'ni yig'adi,
 * superadmin tayyor faylni yuklab oladi. Faqat superadmin; har yuklash
 * faoliyat jurnaliga `export` amali bilan yoziladi.
 *
 * Faqat sxema (yangi jadval) — mavjud ma'lumotga tegilmaydi.
 */
export class CreateCampaignReportExports1716000000107 implements MigrationInterface {
  name = 'CreateCampaignReportExports1716000000107';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."campaign_report_exports" (
        "id" BIGSERIAL PRIMARY KEY,
        "campaign_kind" VARCHAR(16) NOT NULL
          CHECK ("campaign_kind" IN ('notification', 'sms')),
        "campaign_id" BIGINT NOT NULL,
        "requested_by" BIGINT,
        "requested_role" VARCHAR(100),
        "status" VARCHAR(16) NOT NULL DEFAULT 'queued'
          CHECK ("status" IN ('queued', 'running', 'done', 'failed')),
        "row_count" INTEGER NOT NULL DEFAULT 0,
        "csv" TEXT,
        "filename" VARCHAR(200),
        "error" TEXT,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "started_at" TIMESTAMPTZ,
        "finished_at" TIMESTAMPTZ,
        "expires_at" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CAMPAIGN_REPORT_EXPORT_CAMPAIGN"
      ON "notification_schema"."campaign_report_exports" ("campaign_kind", "campaign_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CAMPAIGN_REPORT_EXPORT_CREATED"
      ON "notification_schema"."campaign_report_exports" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."campaign_report_exports"`,
    );
  }
}
