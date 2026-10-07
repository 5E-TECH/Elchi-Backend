import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SMS: provayder akkauntlari (shifrlangan kredensial), shablonlar, reklama
 * roziligi va kampaniyalar tarixi (8auPBa1O, nkhURiKX, sVByLMnt).
 */
export class CreateSmsProviderTemplatesConsent1716000000055 implements MigrationInterface {
  name = 'CreateSmsProviderTemplatesConsent1716000000055';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."sms_provider_accounts" (
        "id" BIGSERIAL PRIMARY KEY,
        "provider" VARCHAR(32) NOT NULL,
        "sender_profile" VARCHAR(16) NOT NULL DEFAULT 'default'
          CHECK ("sender_profile" IN ('default', 'otp')),
        "login_enc" TEXT NOT NULL,
        "password_enc" TEXT NOT NULL,
        "sender" VARCHAR(32) NOT NULL,
        "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
        "updated_by" BIGINT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SMS_PROVIDER_ACCOUNT"
      ON "notification_schema"."sms_provider_accounts" ("provider", "sender_profile")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."sms_templates" (
        "id" BIGSERIAL PRIMARY KEY,
        "code" VARCHAR(64) NOT NULL,
        "message_class" VARCHAR(16) NOT NULL
          CHECK ("message_class" IN ('transactional', 'promo', 'security')),
        "lang" VARCHAR(2) NOT NULL DEFAULT 'uz' CHECK ("lang" IN ('uz', 'ru', 'en')),
        "text" TEXT NOT NULL,
        "required_vars" TEXT[] NOT NULL DEFAULT '{}',
        "provider_template_id" VARCHAR(64),
        "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SMS_TEMPLATE_CODE_LANG"
      ON "notification_schema"."sms_templates" ("code", "lang")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."customer_consent" (
        "id" BIGSERIAL PRIMARY KEY,
        "phone" VARCHAR(16) NOT NULL,
        "customer_id" BIGINT,
        "channel" VARCHAR(8) NOT NULL DEFAULT 'sms' CHECK ("channel" IN ('sms', 'push')),
        "granted" BOOLEAN NOT NULL DEFAULT TRUE,
        "source" VARCHAR(16) NOT NULL
          CHECK ("source" IN ('shartnoma', 'veb-forma', 'buyurtma', 'operator')),
        "granted_at" TIMESTAMPTZ NOT NULL,
        "evidence" JSONB,
        "revoked_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CUSTOMER_CONSENT_PHONE_CHANNEL"
      ON "notification_schema"."customer_consent" ("phone", "channel")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."sms_campaigns" (
        "id" BIGSERIAL PRIMARY KEY,
        "idempotency_key" VARCHAR(128) NOT NULL,
        "created_by" BIGINT,
        "message_class" VARCHAR(16) NOT NULL,
        "template_code" VARCHAR(64),
        "text" TEXT NOT NULL,
        "segment" JSONB NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
        "total" INTEGER NOT NULL DEFAULT 0,
        "queued" INTEGER NOT NULL DEFAULT 0,
        "blocked" INTEGER NOT NULL DEFAULT 0,
        "skipped" INTEGER NOT NULL DEFAULT 0,
        "estimated_cost" NUMERIC(14, 2),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_SMS_CAMPAIGN_IDEMPOTENCY"
      ON "notification_schema"."sms_campaigns" ("idempotency_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'sms_campaigns',
      'customer_consent',
      'sms_templates',
      'sms_provider_accounts',
    ]) {
      await queryRunner.query(
        `DROP TABLE IF EXISTS "notification_schema"."${table}" CASCADE`,
      );
    }
  }
}
