import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C2.3 — Elchi → hamkor chiquvchi webhook outbox jadvali.
 *
 * Order statusi o'zgarganda (partner_shipment_ref bor) shu yerga qator yoziladi;
 * scheduler HMAC-imzoli POST qiladi, xatoda backoff bilan qayta uriniladi,
 * muvaffaqiyatda `completed` (dedup). ExternalIntegration `sync_queue`'dan
 * ataylab ajratilgan (u `integration_id` FK'ga bog'langan). Kontrakt:
 * docs/PARTNER_API.md §4.
 */
export class CreatePartnerWebhookOutbox1716000000023 implements MigrationInterface {
  name = 'CreatePartnerWebhookOutbox1716000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_schema"."partner_webhook_outbox" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "partner_id" BIGINT NOT NULL,
        "order_id" BIGINT NOT NULL,
        "external_order_id" VARCHAR NOT NULL,
        "event_type" VARCHAR NOT NULL,
        "new_status" VARCHAR,
        "payload" JSONB NOT NULL,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 4,
        "last_error" TEXT,
        "last_response" JSONB,
        "next_retry_at" TIMESTAMPTZ,
        "delivered_at" TIMESTAMPTZ
      );
    `);

    // Scheduler pending + muddati kelgan qatorlarni shu indeks bilan oladi.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PWO_STATUS_RETRY"
      ON "integration_schema"."partner_webhook_outbox" ("status", "next_retry_at");
    `);
    // Dedup: bitta (partner, order, status) hodisasi bir marta navbatga tushadi.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PWO_DEDUP"
      ON "integration_schema"."partner_webhook_outbox" ("partner_id", "order_id", "new_status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "integration_schema"."partner_webhook_outbox" CASCADE;`,
    );
  }
}
