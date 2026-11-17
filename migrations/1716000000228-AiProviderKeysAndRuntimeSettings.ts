import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * «AI kalit va modellar» (be-brief v0.2 §4) — `ai_schema`.
 *
 * - `ai_provider_keys` — UI'dan qo'shilgan Anthropic kalitlari. `id` uuid
 *   shifrlashdan OLDIN yaratiladi (AAD `elchi/<APP_ENV>/ai_provider_keys/<id>`).
 *   Bir vaqtda bitta `active` va bitta `previous` (qisman UNIQUE indekslar);
 *   `retired` qatorda shifrmatn YO'Q (`CK_AIKEY_SECRET`). Kalit qiymati hech
 *   qachon ochiq saqlanmaydi: `secret_enc` = `enc:gcm:v1:…`, ko'rinish uchun
 *   faqat oxirgi 4 belgi (`key_hint`) va SHA-256 izi (`fingerprint`).
 * - `ai_runtime_settings` — `keys` (kalit optimistik qulfi), `models`,
 *   `model_catalog`, `env_key_check` (ai_advisor_settings shakli).
 * - `ai_config_attempts` — urinishlar cheklovi (DB'da — qayta ishga tushish
 *   nolga tushirmaydi).
 * - `ai_usage_log` + `key_id`, `key_source`, `key_fingerprint`,
 *   `config_version` (qaysi kalit/sozlama bilan chaqirilgani; BE-1c yozadi).
 *
 * ⚠️ Faqat yangi jadvallar/ustunlar — mavjud ma'lumotga tegmaydi, qayta
 * yurgizish xavfsiz (IF NOT EXISTS). `"createdAt"`/`"updatedAt"` camelCase.
 */
const SCHEMA = 'ai_schema';

export class AiProviderKeysAndRuntimeSettings1716000000228 implements MigrationInterface {
  name = 'AiProviderKeysAndRuntimeSettings1716000000228';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_provider_keys" (
        "id" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "provider" character varying(16) NOT NULL DEFAULT 'anthropic',
        "status" character varying(16) NOT NULL,
        "label" character varying(60),
        "secret_enc" text,
        "key_hint" character varying(8) NOT NULL,
        "fingerprint" character varying(16) NOT NULL,
        "verify_state" character varying(16) NOT NULL DEFAULT 'unverified',
        "verify_origin" character varying(8) NOT NULL DEFAULT 'verify',
        "verify_error_code" character varying(40),
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "rejected_at" TIMESTAMP WITH TIME ZONE,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(64) NOT NULL,
        "created_by_name" character varying(120),
        "retired_at" TIMESTAMP WITH TIME ZONE,
        "retired_by" character varying(64),
        CONSTRAINT "PK_ai_provider_keys_id" PRIMARY KEY ("id"),
        CONSTRAINT "CK_AIKEY_PROVIDER" CHECK ("provider" IN ('anthropic')),
        CONSTRAINT "CK_AIKEY_STATUS" CHECK ("status" IN ('active','previous','retired','swap')),
        CONSTRAINT "CK_AIKEY_VERIFY_STATE" CHECK ("verify_state" IN ('ok','rejected','forbidden','bad_request','billing','unavailable','unverified')),
        CONSTRAINT "CK_AIKEY_VERIFY_ORIGIN" CHECK ("verify_origin" IN ('verify','runtime')),
        CONSTRAINT "CK_AIKEY_SECRET" CHECK (("status" = 'retired') = ("secret_enc" IS NULL))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AIKEY_ACTIVE" ON "${SCHEMA}"."ai_provider_keys" ("provider") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AIKEY_PREVIOUS" ON "${SCHEMA}"."ai_provider_keys" ("provider") WHERE "status" = 'previous'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_runtime_settings" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "key" character varying(64) NOT NULL,
        "value" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "version" integer NOT NULL DEFAULT 1,
        "updated_by" character varying(64),
        "updated_by_name" character varying(120),
        CONSTRAINT "PK_ai_runtime_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "CK_AI_RUNTIME_SETTINGS_VERSION" CHECK ("version" >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_RUNTIME_SETTINGS_KEY" ON "${SCHEMA}"."ai_runtime_settings" ("key")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_config_attempts" (
        "id" bigserial NOT NULL,
        "requester_id" character varying(64) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_config_attempts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CK_AICFG_ATT_KIND" CHECK ("kind" IN ('key','catalog'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IX_AICFG_ATT_REQ" ON "${SCHEMA}"."ai_config_attempts" ("requester_id", "kind", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IX_AICFG_ATT_ALL" ON "${SCHEMA}"."ai_config_attempts" ("kind", "created_at")`,
    );

    // Postgres 11+: NULL ustun qo'shish — faqat katalog o'zgarishi.
    await queryRunner.query(`
      ALTER TABLE "${SCHEMA}"."ai_usage_log"
        ADD COLUMN IF NOT EXISTS "key_id" uuid,
        ADD COLUMN IF NOT EXISTS "key_source" character varying(8),
        ADD COLUMN IF NOT EXISTS "key_fingerprint" character varying(16),
        ADD COLUMN IF NOT EXISTS "config_version" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "${SCHEMA}"."ai_usage_log"
        DROP COLUMN IF EXISTS "config_version",
        DROP COLUMN IF EXISTS "key_fingerprint",
        DROP COLUMN IF EXISTS "key_source",
        DROP COLUMN IF EXISTS "key_id"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_config_attempts"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_runtime_settings"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_provider_keys"`,
    );
  }
}
