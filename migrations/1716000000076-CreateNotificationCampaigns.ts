import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notification_schema.notification_campaigns` — bildirishnoma kampaniyasi
 * navbati (xHPdpj0W). Katta yuborish asinxron: 202 + progress + tarix.
 *
 * • `idempotency_key` UNIQUE — admin qayta bossa ikkinchi kampaniya
 *   yaratilmaydi (504 dan keyingi takror bosish dublikati yo'q).
 * • `batch_no` + `cursor_after_id` — partiya da'vosi va keyset kursor:
 *   qayta yetkazilgan partiya (outbox at-least-once) ikki marta yozmaydi.
 * • soft-delete ustuni `is_deleted`; vaqt ustunlari `notifications` bilan bir
 *   xil (`createdAt`/`updatedAt`, BaseEntity).
 *
 * Kechiktirish (`scheduled_at`) faqat outbox `scheduled_at` orqali — RabbitMQ
 * navbat argumentlariga TEGILMAYDI (2026-09-14 hodisasi). Yangi navbat ham,
 * scheduler servis ham yo'q.
 */
export class CreateNotificationCampaigns1716000000076 implements MigrationInterface {
  name = 'CreateNotificationCampaigns1716000000076';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_campaigns" (
        "id" BIGSERIAL PRIMARY KEY,
        "created_by" BIGINT,
        "type" VARCHAR(120) NOT NULL,
        "category" VARCHAR(32) NOT NULL,
        "priority" VARCHAR(16) NOT NULL,
        "channels" JSONB NOT NULL,
        "audience" JSONB NOT NULL,
        "template_code" VARCHAR(64),
        "title" VARCHAR(255) NOT NULL,
        "body" TEXT,
        "data" JSONB,
        "link" VARCHAR(512),
        "status" VARCHAR(16) NOT NULL DEFAULT 'queued'
          CHECK ("status" IN ('draft', 'queued', 'running', 'done', 'failed', 'cancelled')),
        "total" INTEGER NOT NULL DEFAULT 0,
        "sent" INTEGER NOT NULL DEFAULT 0,
        "failed" INTEGER NOT NULL DEFAULT 0,
        "skipped" INTEGER NOT NULL DEFAULT 0,
        "batch_size" INTEGER NOT NULL DEFAULT 200,
        "batch_no" INTEGER NOT NULL DEFAULT 0,
        "batch_attempts" INTEGER NOT NULL DEFAULT 0,
        "cursor_after_id" BIGINT,
        "scheduled_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ,
        "finished_at" TIMESTAMPTZ,
        "last_batch_at" TIMESTAMPTZ,
        "cancelled_at" TIMESTAMPTZ,
        "cancelled_by" BIGINT,
        "last_error" TEXT,
        "idempotency_key" VARCHAR(128) NOT NULL,
        "request_hash" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_NOTIF_CAMPAIGN_IDEMPOTENCY"
      ON "notification_schema"."notification_campaigns" ("idempotency_key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_CAMPAIGN_STATUS"
      ON "notification_schema"."notification_campaigns" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_CAMPAIGN_CREATED"
      ON "notification_schema"."notification_campaigns" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_campaigns" CASCADE`,
    );
  }
}
