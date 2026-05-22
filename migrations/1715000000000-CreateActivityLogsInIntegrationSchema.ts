import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `activity_logs` to integration_schema so integration-service can
 * record sync queue ticks, webhook events, etc. via ActivityLogService.
 *
 * The canonical DDL lives in 1714800000000-CreateActivityLogsTables.ts;
 * keep this file in lockstep when schema changes. We do NOT retroactively
 * edit the original migration because some environments have already run
 * it — a fresh migration is the only safe way to extend coverage.
 */
const SCHEMA = 'integration_schema';

export class CreateActivityLogsInIntegrationSchema1715000000000 implements MigrationInterface {
  name = 'CreateActivityLogsInIntegrationSchema1715000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."activity_logs" (
        "id" BIGSERIAL PRIMARY KEY,
        "entity_type" VARCHAR(64) NOT NULL,
        "entity_id" VARCHAR(100) NOT NULL,
        "action" VARCHAR(32) NOT NULL,
        "old_value" JSONB,
        "new_value" JSONB,
        "user_id" VARCHAR(100),
        "user_name" VARCHAR(200),
        "user_role" VARCHAR(32),
        "service" VARCHAR(32),
        "trace_id" VARCHAR(64),
        "metadata" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ENTITY_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("entity_type", "entity_id", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_USER_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("user_id", "created_at" DESC)
      WHERE "user_id" IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ACTION_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("action", "created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_CREATED_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_TRACE_${SCHEMA}"
      ON "${SCHEMA}"."activity_logs" ("trace_id")
      WHERE "trace_id" IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${SCHEMA}"."activity_logs" CASCADE;`,
    );
  }
}
