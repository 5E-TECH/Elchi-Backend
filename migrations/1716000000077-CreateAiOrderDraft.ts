import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * vncdmXOy — AI buyurtma AUDIT IZI (`ai_schema`, ai-service).
 *
 * 1. `ai_order_draft` — bitta ai-parse = bitta qator (`id` = draft_id):
 *    maskalangan xom matn (`[TEL_n]`), asl matn xeshi, model, prompt
 *    versiyasi, LLM xom chiqishi, AI taklifi snapshot'i. Retention (30 kun)
 *    `source_text`/`raw_extraction`/`resolved_preview` ni NULL qiladi,
 *    `source_hash` QOLADI. RASM SAQLANMAYDI (faqat `image_count`).
 * 2. `ai_order_draft_item` — draft ↔ buyurtma (order_id UNIQUE) va server
 *    hisoblagan `edited_fields`. activity_log fire-and-forget bo'lgani uchun
 *    bog'lanishning asosiy manbai shu jadval.
 *
 * ⚠️ `order_schema` ga TEGMAYDI: Order_source enumi o'zgarmaydi (TC11) —
 * AI belgisi activity_log metadata + shu jadvallar orqali.
 * Yangi jadvallar — mavjud ma'lumotga ta'sir yo'q; `IF NOT EXISTS` bilan.
 */
const SCHEMA = 'ai_schema';

export class CreateAiOrderDraft1716000000077 implements MigrationInterface {
  name = 'CreateAiOrderDraft1716000000077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_order_draft" (
        "id" uuid NOT NULL,
        "market_id" bigint NOT NULL,
        "user_id" bigint,
        "trace_id" character varying(64),
        "source_kind" character varying(16) NOT NULL,
        "source_text" text,
        "source_hash" character(64) NOT NULL,
        "source_chars" integer NOT NULL DEFAULT 0,
        "image_count" integer NOT NULL DEFAULT 0,
        "model" character varying(64) NOT NULL,
        "prompt_version" character varying(32) NOT NULL,
        "outcome" character varying(16) NOT NULL DEFAULT 'ok',
        "raw_extraction" jsonb,
        "resolved_preview" jsonb,
        "preview_count" integer NOT NULL DEFAULT 0,
        "text_purged_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_order_draft" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIDRAFT_MARKET_CREATED"
      ON "${SCHEMA}"."ai_order_draft" ("market_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIDRAFT_SOURCE_HASH"
      ON "${SCHEMA}"."ai_order_draft" ("source_hash")
    `);
    // Retention job faqat hali tozalanmagan qatorlarni ko'radi.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIDRAFT_RETENTION"
      ON "${SCHEMA}"."ai_order_draft" ("created_at")
      WHERE "text_purged_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."ai_order_draft_item" (
        "id" bigserial NOT NULL,
        "draft_id" uuid NOT NULL,
        "item_index" integer,
        "order_id" bigint NOT NULL,
        "market_id" bigint NOT NULL,
        "confirmed_by" bigint,
        "edited_fields" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_order_draft_item" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_order_draft_item_draft" FOREIGN KEY ("draft_id")
          REFERENCES "${SCHEMA}"."ai_order_draft" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AIDRAFT_ITEM_ORDER"
      ON "${SCHEMA}"."ai_order_draft_item" ("order_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_AIDRAFT_ITEM_DRAFT"
      ON "${SCHEMA}"."ai_order_draft_item" ("draft_id", "item_index")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_order_draft_item"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."ai_order_draft"`,
    );
  }
}
