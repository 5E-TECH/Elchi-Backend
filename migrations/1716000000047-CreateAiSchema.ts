import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ai_schema` — ai-service'ning o'z sxemasi (C12): AI xarajat jurnali,
 * global kunlik shift hisoblagichi va audit jadvali.
 *
 * 1. `ai_usage_log` — HAR Anthropic javobi uchun bitta qator (retry ham
 *    alohida). Aniq tokenlar, USD/so'm xarajat, amal qilgan narx va
 *    MAJBURIY meta (market/user/draft/trace).
 *    ⚠️ Xom matn ustuni YO'Q — faqat `input_chars`, `input_sha256`,
 *    `image_count`. Mijoz PII'si (ism/telefon/manzil) bazaga tushmaydi.
 *    ⚠️ market_id/user_id saqlanadi → retention siyosati kerak (12 oy) —
 *    alohida karta.
 * 2. `ai_spend_counter` — global kunlik avariya shifti uchun SINXRON
 *    hisoblagich: `PRIMARY KEY (scope, period_key)`, atomik
 *    `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. Jurnal
 *    fire-and-forget bo'lgani uchun shift unga TAYANMAYDI.
 *    `period_key` — Toshkent sanasi (Asia/Tashkent, UTC+5).
 * 3. `activity_logs` — SUPERADMIN'ning "shiftni ko'tarish" amali auditi.
 *    ⚠️ DDL `1714800000000-CreateActivityLogsTables` ning JORIY holati:
 *    `1716000000009-ExtendActivityLogsCoverage` `action` ni VARCHAR(64) ga
 *    kengaytirgan (boshqa ALTER yo'q) — bu yerda darhol 64.
 *
 * ⚠️ Soft-delete ustuni `is_deleted` (BaseEntity `name: 'is_deleted'`),
 * `"createdAt"`/`"updatedAt"` esa HAQIQATAN camelCase — aralashtirilsa har
 * INSERT `42703 undefined_column` bilan yiqiladi.
 */
const SCHEMA = 'ai_schema';

export class CreateAiSchema1716000000047 implements MigrationInterface {
  name = 'CreateAiSchema1716000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    // ─── 1. ai_usage_log ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_usage_log" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "feature" character varying(40) NOT NULL,
        "request_area" character varying(16) NOT NULL DEFAULT 'other',
        "model" character varying(64) NOT NULL,
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "cache_creation_tokens" integer NOT NULL DEFAULT 0,
        "cache_read_tokens" integer NOT NULL DEFAULT 0,
        "steps" integer NOT NULL DEFAULT 1,
        "stop_reason" character varying(32),
        "outcome" character varying(16) NOT NULL DEFAULT 'ok',
        "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
        "cache_saved_usd" numeric(12,6) NOT NULL DEFAULT 0,
        "cost_uzs" numeric(14,2) NOT NULL DEFAULT 0,
        "usd_uzs_rate" numeric(12,2) NOT NULL DEFAULT 0,
        "applied_price_uzs" numeric(14,2),
        "market_id" bigint,
        "user_id" bigint,
        "draft_id" uuid,
        "trace_id" character varying(64),
        "order_ids" bigint[] NOT NULL DEFAULT '{}',
        "meta_incomplete" boolean NOT NULL DEFAULT false,
        "input_chars" integer,
        "input_sha256" character(64),
        "image_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_ai_usage_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIUSAGE_MARKET_CREATED"
      ON "${SCHEMA}"."ai_usage_log" ("market_id", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIUSAGE_FEATURE_CREATED"
      ON "${SCHEMA}"."ai_usage_log" ("feature", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIUSAGE_AREA_CREATED"
      ON "${SCHEMA}"."ai_usage_log" ("request_area", "createdAt")
    `);
    // ai-confirm'dan keyin `ai.usage.link_orders` shu indeks bo'yicha
    // draft qatorlarini topadi.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIUSAGE_DRAFT"
      ON "${SCHEMA}"."ai_usage_log" ("draft_id")
      WHERE "draft_id" IS NOT NULL
    `);

    // ─── 2. ai_spend_counter ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_spend_counter" (
        "scope" character varying(16) NOT NULL DEFAULT 'global',
        "period_key" date NOT NULL,
        "cost_usd" numeric(14,6) NOT NULL DEFAULT 0,
        "cost_uzs" numeric(16,2) NOT NULL DEFAULT 0,
        "calls" integer NOT NULL DEFAULT 0,
        "override_usd" numeric(12,2) NOT NULL DEFAULT 0,
        "warned_at" TIMESTAMP WITH TIME ZONE,
        "exceeded_at" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_spend_counter" PRIMARY KEY ("scope", "period_key")
      )
    `);

    // ─── 3. activity_logs (joriy DDL, action VARCHAR(64)) ──────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."activity_logs" (
        "id" BIGSERIAL PRIMARY KEY,
        "entity_type" VARCHAR(64) NOT NULL,
        "entity_id" VARCHAR(100) NOT NULL,
        "action" VARCHAR(64) NOT NULL,
        "old_value" JSONB,
        "new_value" JSONB,
        "user_id" VARCHAR(100),
        "user_name" VARCHAR(200),
        "user_role" VARCHAR(32),
        "service" VARCHAR(32),
        "trace_id" VARCHAR(64),
        "metadata" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ENTITY_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("entity_type", "entity_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_USER_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("user_id", "created_at" DESC)
      WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ACTION_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("action", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_CREATED_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_TRACE_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("trace_id")
      WHERE "trace_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const indexes = [
      `IDX_ACTIVITY_TRACE_${SCHEMA}`,
      `IDX_ACTIVITY_CREATED_${SCHEMA}`,
      `IDX_ACTIVITY_ACTION_${SCHEMA}`,
      `IDX_ACTIVITY_USER_${SCHEMA}`,
      `IDX_ACTIVITY_ENTITY_${SCHEMA}`,
      'IDX_AIUSAGE_DRAFT',
      'IDX_AIUSAGE_AREA_CREATED',
      'IDX_AIUSAGE_FEATURE_CREATED',
      'IDX_AIUSAGE_MARKET_CREATED',
    ];
    for (const index of indexes) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${SCHEMA}"."${index}"`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "${SCHEMA}"."activity_logs"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_spend_counter"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "${SCHEMA}"."ai_usage_log"`);
    // ⚠️ RESTRICT (sukut): sxemada boshqa obyekt qolgan bo'lsa yiqiladi —
    // begona ma'lumotni jimgina CASCADE bilan o'chirib yubormaydi.
    await queryRunner.query(`DROP SCHEMA IF EXISTS "${SCHEMA}"`);
  }
}
