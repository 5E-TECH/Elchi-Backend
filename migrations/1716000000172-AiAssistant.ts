import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F7PWp6cK — AI moliyaviy yordamchi (`ai_schema`):
 *
 * - `ai_conversations` — foydalanuvchi suhbatlari (sarlavha, savollar soni,
 *   token/narx yig'indisi);
 * - `ai_messages` — AUDIT IZI va API tarixi (append-only): savol, har qadam
 *   javobi (Anthropic content bloklari o'zgarishsiz, token, narx), tool
 *   chaqiruvlari (nom, kirish, ok, yozuvlar soni, davr), yakuniy javob
 *   manbalari bilan;
 * - `ai_assistant_access` — ADMIN ruxsati (superadmin tanlaydi): enabled,
 *   daily_limit (NULL — sukut).
 *
 * ⚠️ Faqat yangi jadvallar — mavjud ma'lumotga tegmaydi, qayta yurgizish
 * xavfsiz (IF NOT EXISTS). `is_deleted` (BaseEntity), `"createdAt"` /
 * `"updatedAt"` camelCase.
 */
const SCHEMA = 'ai_schema';

export class AiAssistant1716000000172 implements MigrationInterface {
  name = 'AiAssistant1716000000172';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_conversations" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "user_id" bigint NOT NULL,
        "title" character varying(200) NOT NULL DEFAULT '',
        "turns" integer NOT NULL DEFAULT 0,
        "last_message_at" TIMESTAMP WITH TIME ZONE,
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_ai_conversations_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_CONV_USER_LAST" ON "${SCHEMA}"."ai_conversations" ("user_id", "last_message_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_messages" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "conversation_id" bigint NOT NULL,
        "user_id" bigint NOT NULL,
        "seq" integer NOT NULL,
        "role" character varying(16) NOT NULL,
        "text" text,
        "content" jsonb,
        "tool_calls" jsonb,
        "sources" jsonb,
        "is_final" boolean NOT NULL DEFAULT false,
        "model" character varying(64),
        "step" integer,
        "stop_reason" character varying(32),
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "cache_read_tokens" integer NOT NULL DEFAULT 0,
        "cache_creation_tokens" integer NOT NULL DEFAULT 0,
        "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
        "trace_id" character varying(64),
        CONSTRAINT "PK_ai_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_AI_MESSAGES_ROLE" CHECK ("role" IN ('user','assistant','tool')),
        CONSTRAINT "FK_ai_messages_conversation" FOREIGN KEY ("conversation_id")
          REFERENCES "${SCHEMA}"."ai_conversations" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_MSG_CONV_SEQ" ON "${SCHEMA}"."ai_messages" ("conversation_id", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_AI_MSG_USER_CREATED" ON "${SCHEMA}"."ai_messages" ("user_id", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_assistant_access" (
        "id" bigserial NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "user_id" bigint NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "daily_limit" integer,
        "updated_by" bigint,
        CONSTRAINT "PK_ai_assistant_access_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_AI_ASSISTANT_ACCESS_LIMIT"
          CHECK ("daily_limit" IS NULL OR ("daily_limit" >= 0 AND "daily_limit" <= 10000))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AI_ASSISTANT_ACCESS_USER" ON "${SCHEMA}"."ai_assistant_access" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_assistant_access"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "${SCHEMA}"."ai_messages"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_conversations"`,
    );
  }
}
