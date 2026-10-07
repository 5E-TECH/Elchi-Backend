import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notification_schema.sms_outbox` — SMS navbati (3fRbyadQ).
 *
 * Qayta urinish ustunlari `integration_schema.sync_queue` bilan bir xil nomda.
 * `client_message_id` UNIQUE — bir xil xabar ikki marta navbatga tushmaydi,
 * DLR shu bo'yicha moslanadi. `cost` NULL bo'lishi mumkin: tarif sozlanmagan.
 */
export class CreateSmsOutbox1716000000054 implements MigrationInterface {
  name = 'CreateSmsOutbox1716000000054';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."sms_outbox" (
        "id" BIGSERIAL PRIMARY KEY,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK ("status" IN ('pending', 'processing', 'sent', 'delivered', 'failed')),
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "retry_count" INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 3,
        "last_error" TEXT,
        "last_response" JSONB,
        "next_retry_at" TIMESTAMPTZ,
        "to_phone" VARCHAR(16) NOT NULL,
        "text" TEXT NOT NULL,
        "message_class" VARCHAR(16) NOT NULL
          CHECK ("message_class" IN ('transactional', 'promo', 'security')),
        "template_code" VARCHAR(64),
        "parts" INTEGER NOT NULL,
        "encoding" VARCHAR(8) NOT NULL CHECK ("encoding" IN ('GSM-7', 'UCS-2')),
        "provider" VARCHAR(32) NOT NULL,
        "sender_profile" VARCHAR(16) NOT NULL DEFAULT 'default'
          CHECK ("sender_profile" IN ('default', 'otp')),
        "client_message_id" VARCHAR(64) NOT NULL,
        "provider_message_id" VARCHAR(128),
        "dlr_status" VARCHAR(20),
        "dlr_at" TIMESTAMPTZ,
        "cost" NUMERIC(14, 2),
        "notification_id" BIGINT,
        "campaign_id" BIGINT,
        "scheduled_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "sent_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SMS_OUTBOX_CLIENT_MESSAGE_ID"
      ON "notification_schema"."sms_outbox" ("client_message_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SMS_OUTBOX_RETRY"
      ON "notification_schema"."sms_outbox" ("status", "next_retry_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SMS_OUTBOX_CREATED"
      ON "notification_schema"."sms_outbox" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."sms_outbox" CASCADE`,
    );
  }
}
