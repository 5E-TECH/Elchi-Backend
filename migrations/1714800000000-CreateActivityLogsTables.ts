import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `activity_logs` table in every service schema that should
 * record entity-level audit events. Each row captures: which entity
 * changed (entity_type + entity_id), what happened (action), the diff
 * (old_value/new_value JSONB), the actor (user_id/name/role denormalised
 * so a renamed/deleted user does not destroy history), and trace_id for
 * correlation with logs.
 *
 * If a new service starts producing audit events, add its schema to
 * `AUDITED_SCHEMAS` and create a follow-up migration that mirrors the
 * DDL below — do not retroactively edit this migration.
 */
const AUDITED_SCHEMAS = [
  'order_schema',
  'finance_schema',
  'identity_schema',
  'branch_schema',
];

export class CreateActivityLogsTables1714800000000 implements MigrationInterface {
  name = 'CreateActivityLogsTables1714800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const schema of AUDITED_SCHEMAS) {
      await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${schema}"."activity_logs" (
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
        CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ENTITY_${schema}"
        ON "${schema}"."activity_logs" ("entity_type", "entity_id", "created_at" DESC);
      `);

      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_USER_${schema}"
        ON "${schema}"."activity_logs" ("user_id", "created_at" DESC)
        WHERE "user_id" IS NOT NULL;
      `);

      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_ACTION_${schema}"
        ON "${schema}"."activity_logs" ("action", "created_at" DESC);
      `);

      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_CREATED_${schema}"
        ON "${schema}"."activity_logs" ("created_at" DESC);
      `);

      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_ACTIVITY_TRACE_${schema}"
        ON "${schema}"."activity_logs" ("trace_id")
        WHERE "trace_id" IS NOT NULL;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const schema of AUDITED_SCHEMAS) {
      await queryRunner.query(
        `DROP TABLE IF EXISTS "${schema}"."activity_logs" CASCADE;`,
      );
    }
  }
}
