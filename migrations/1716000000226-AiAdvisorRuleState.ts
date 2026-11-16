import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-5 (LhTIno57) — AI maslahatchi qoidalar holati (`ai_schema`), API
 * shartnomasi v0.3 §4.0, §4.3:
 *
 * - `ai_advisor_rule_state` — har qoida (R1…R8) uchun bitta qator:
 *   kursor (R1 `closed_at`, R3 `createdAt`, R7 `ai_checked_at`),
 *   birinchi/oxirgi ishga tushish (§4.3 backfill — 24 soatdan eski
 *   faktlar bildirishnomasiz), oxirgi natija (kuzatuv uchun: `ok` |
 *   `partial` | `error`, `last_failed`), `failures` — vaqtinchalik xatoli
 *   nomzodlar hisoblagichi `{dedup_key: n}` (round-2: kursor ushlab turiladi,
 *   N urinishdan keyin o'tkazib yuboriladi). R6 kursori — oxirgi tekshirilgan
 *   yopilgan kun oxiri (o'tkazilgan kunlar keyin tekshiriladi).
 *
 * ⚠️ Faqat yangi jadval, IF NOT EXISTS — qayta yurgizish xavfsiz.
 * (225 — AI aniqligi sessiyasi, `ai_usage_log` 1 soatlik kesh.)
 */
const SCHEMA = 'ai_schema';

export class AiAdvisorRuleState1716000000226 implements MigrationInterface {
  name = 'AiAdvisorRuleState1716000000226';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_advisor_rule_state" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "rule_key" character varying(4) NOT NULL,
        "cursor_at" TIMESTAMP WITH TIME ZONE,
        "first_run_at" TIMESTAMP WITH TIME ZONE,
        "last_run_at" TIMESTAMP WITH TIME ZONE,
        "last_status" character varying(16),
        "last_error" character varying(300),
        "last_candidates" integer NOT NULL DEFAULT 0,
        "last_failed" integer NOT NULL DEFAULT 0,
        "failures" jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "PK_ai_advisor_rule_state_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_AI_ADVISOR_RULE_STATE_RULE"
          CHECK ("rule_key" IN ('R1','R2','R3','R4','R5','R6','R7','R8'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_ADVISOR_RULE_STATE_RULE" ON "${SCHEMA}"."ai_advisor_rule_state" ("rule_key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_advisor_rule_state"`,
    );
  }
}
