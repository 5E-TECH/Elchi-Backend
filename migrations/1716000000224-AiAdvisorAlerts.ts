import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (LhTIno57) — AI maslahatchi: ogohlantirishlar R1–R8 (`ai_schema`).
 * API shartnomasi v0.3 §5, §6, §7.6.
 *
 * - `ai_advisor_alerts` — ogohlantirish qatori (haqiqat manbai: holat,
 *   kim/qachon ko'rdi/yopdi, izoh). Bitta `dedup_key` uchun bir vaqtda
 *   faqat BITTA ochiq (`new`/`seen`) qator — qisman UNIQUE indeks.
 * - `ai_advisor_alert_occurrences` — takrorlar: `UNIQUE (dedup_key,
 *   fact_key)` — ayni fakt (R2/R4/R5 da ayni epizod) yopilgandan keyin ham
 *   yangi ogohlantirish ochmaydi.
 * - `ai_advisor_settings` — `key` → `value jsonb` (hozircha `rules`;
 *   BE-1 `telegram`/`budget`/`schedule` qo'shadi), `version` — optimistik
 *   qulf (API `version` = barcha kalitlar ichida MAX).
 *
 * ⚠️ Faqat yangi jadvallar — mavjud ma'lumotga tegmaydi, qayta yurgizish
 * xavfsiz (IF NOT EXISTS). `is_deleted` (BaseEntity), `"createdAt"` /
 * `"updatedAt"` camelCase.
 */
const SCHEMA = 'ai_schema';

export class AiAdvisorAlerts1716000000224 implements MigrationInterface {
  name = 'AiAdvisorAlerts1716000000224';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_advisor_alerts" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "rule_key" character varying(4) NOT NULL,
        "severity" character varying(16) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'new',
        "dedup_key" character varying(200) NOT NULL,
        "title" character varying(200) NOT NULL DEFAULT '',
        "branch_id" bigint,
        "branch" jsonb,
        "subject" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "headline_amount" numeric(20,2),
        "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "links" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "rule_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "occurrences" integer NOT NULL DEFAULT 1,
        "first_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "first_fact_at" TIMESTAMP WITH TIME ZONE,
        "last_fact_at" TIMESTAMP WITH TIME ZONE,
        "explanation_status" character varying(16) NOT NULL DEFAULT 'none',
        "explanation_md" text,
        "explanation_error" character varying(32),
        "explanation_error_scope" character varying(16),
        "explanation_retry_at" TIMESTAMP WITH TIME ZONE,
        "explanation_requested_at" TIMESTAMP WITH TIME ZONE,
        "explained_at" TIMESTAMP WITH TIME ZONE,
        "explanation_model" character varying(64),
        "kb_version" character varying(32),
        "seen_at" TIMESTAMP WITH TIME ZONE,
        "seen_by" bigint,
        "seen_by_name" character varying(200),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by" bigint,
        "resolved_by_name" character varying(200),
        "resolution_note" character varying(500),
        "reopened_from_id" bigint,
        "notified_at" TIMESTAMP WITH TIME ZONE,
        "notify_skipped" character varying(32),
        CONSTRAINT "PK_ai_advisor_alerts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_AI_ADVISOR_ALERT_RULE"
          CHECK ("rule_key" IN ('R1','R2','R3','R4','R5','R6','R7','R8')),
        CONSTRAINT "CHK_AI_ADVISOR_ALERT_SEVERITY"
          CHECK ("severity" IN ('warning','critical')),
        CONSTRAINT "CHK_AI_ADVISOR_ALERT_STATUS"
          CHECK ("status" IN ('new','seen','resolved','dismissed')),
        CONSTRAINT "CHK_AI_ADVISOR_ALERT_EXPL_STATUS"
          CHECK ("explanation_status" IN ('none','pending','ready','failed')),
        CONSTRAINT "CHK_AI_ADVISOR_ALERT_OCCURRENCES" CHECK ("occurrences" >= 1)
      )
    `);
    // Bitta dedup_key uchun faqat bitta OCHIQ ogohlantirish (§5).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_ADVISOR_ALERT_OPEN_DEDUP" ON "${SCHEMA}"."ai_advisor_alerts" ("dedup_key") WHERE "status" IN ('new','seen')`,
    );
    // Ro'yxat: sukut saralash `last_at DESC, id DESC`, holat filtri.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_ADVISOR_ALERT_STATUS_LAST" ON "${SCHEMA}"."ai_advisor_alerts" ("status", "last_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_ADVISOR_ALERT_LAST" ON "${SCHEMA}"."ai_advisor_alerts" ("last_at" DESC, "id" DESC)`,
    );
    // Oxirgi yopilgan ogohlantirish (`reopened_from_id`) qidiruvi.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_ADVISOR_ALERT_DEDUP" ON "${SCHEMA}"."ai_advisor_alerts" ("dedup_key", "id" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_advisor_alert_occurrences" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "alert_id" bigint NOT NULL,
        "dedup_key" character varying(200) NOT NULL,
        "fact_key" character varying(200) NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "fact_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_ai_advisor_alert_occurrences_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_advisor_alert_occurrences_alert" FOREIGN KEY ("alert_id")
          REFERENCES "${SCHEMA}"."ai_advisor_alerts" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_ADVISOR_OCC_DEDUP_FACT" ON "${SCHEMA}"."ai_advisor_alert_occurrences" ("dedup_key", "fact_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_ADVISOR_OCC_ALERT" ON "${SCHEMA}"."ai_advisor_alert_occurrences" ("alert_id", "occurred_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_advisor_settings" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "key" character varying(64) NOT NULL,
        "value" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "version" integer NOT NULL DEFAULT 1,
        "updated_by" bigint,
        "updated_by_name" character varying(200),
        CONSTRAINT "PK_ai_advisor_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_AI_ADVISOR_SETTINGS_VERSION" CHECK ("version" >= 1)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_ADVISOR_SETTINGS_KEY" ON "${SCHEMA}"."ai_advisor_settings" ("key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_advisor_settings"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_advisor_alert_occurrences"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_advisor_alerts"`,
    );
  }
}
