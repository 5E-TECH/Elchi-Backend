import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHMAIqyo #5 — AI buyurtma tezligini o'lchash (p50/p95).
 *
 * - `ai_schema.ai_usage_log.latency_ms` — HAR Anthropic chaqiruvining
 *   davomiyligi (ClaudeService o'lchaydi; bo'laklab ekstraksiyada har bo'lak
 *   alohida qator).
 * - `ai_schema.ai_order_draft.extract_ms | preview_ms | total_ms` — bitta
 *   ai-parse bosqichlari (gateway o'lchaydi, `ai.draft.attach_preview` bilan
 *   keladi): extract = `ai.order.extract` RPC, preview =
 *   `order.ai_resolve_preview`, total = butun handler.
 *
 * Hammasi NULL'li ustun (eski qatorlar NULL) — qayta yurgizish xavfsiz
 * (IF NOT EXISTS), mavjud ma'lumotga tegmaydi, jadval qulflanishi qisqa
 * (default'siz ADD COLUMN — qayta yozish yo'q).
 */
export class AiOrderLatency1716000000170 implements MigrationInterface {
  name = 'AiOrderLatency1716000000170';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_usage_log"
        ADD COLUMN IF NOT EXISTS "latency_ms" INT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft"
        ADD COLUMN IF NOT EXISTS "extract_ms" INT NULL,
        ADD COLUMN IF NOT EXISTS "preview_ms" INT NULL,
        ADD COLUMN IF NOT EXISTS "total_ms" INT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_order_draft"
        DROP COLUMN IF EXISTS "total_ms",
        DROP COLUMN IF EXISTS "preview_ms",
        DROP COLUMN IF EXISTS "extract_ms"
    `);
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_usage_log"
        DROP COLUMN IF EXISTS "latency_ms"
    `);
  }
}
