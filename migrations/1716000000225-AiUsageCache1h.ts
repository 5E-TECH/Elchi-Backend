import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1 (AI keshlash): `ai_usage_log.cache_creation_1h_tokens` — kesh yozish
 * tokenlaridan 1 soatlik TTL bilan yozilgani (`usage.cache_creation.
 * ephemeral_1h_input_tokens`). Narxi kirish × 2 (5 daqiqalik × 1.25),
 * shuning uchun xarajat va "keshdan ulush" hisobi uchun alohida saqlanadi.
 * `cache_creation_tokens` JAMI bo'lib qoladi (5m + 1h).
 *
 * Postgres 11+ da `DEFAULT 0` faqat katalog o'zgarishi — backfill yo'q.
 * `IF NOT EXISTS` — qayta yurgizish xatosiz.
 */
export class AiUsageCache1h1716000000225 implements MigrationInterface {
  name = 'AiUsageCache1h1716000000225';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_usage_log"
        ADD COLUMN IF NOT EXISTS "cache_creation_1h_tokens" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_schema"."ai_usage_log"
        DROP COLUMN IF EXISTS "cache_creation_1h_tokens"
    `);
  }
}
