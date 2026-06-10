import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends audit-log coverage so EVERY service that mutates state can record it:
 *
 *  1. Creates `activity_logs` in the schemas that were missing it
 *     (logistics/catalog/investor/notification) — mirrors the DDL of
 *     1714800000000-CreateActivityLogsTables. Without this, audit writes from
 *     those services are silently dropped (ActivityLogService.log is fail-safe).
 *  2. Widens `action` from VARCHAR(32) to VARCHAR(64) in ALL audit schemas so
 *     longer domain verbs (e.g. `notification.telegram_group_connected`,
 *     `logistics.district.sato_bulk_apply`) fit without truncation. Increasing
 *     a varchar length is a metadata-only change in Postgres (no table rewrite).
 */
const NEW_SCHEMAS = [
  'logistics_schema',
  'catalog_schema',
  'investor_schema',
  'notification_schema',
];

// Every schema that holds an activity_logs table after this migration runs.
const ALL_AUDIT_SCHEMAS = [
  'order_schema',
  'finance_schema',
  'identity_schema',
  'branch_schema',
  'integration_schema',
  ...NEW_SCHEMAS,
];

export class ExtendActivityLogsCoverage1716000000009
  implements MigrationInterface
{
  name = 'ExtendActivityLogsCoverage1716000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Create the table in the newly-audited schemas.
    for (const schema of NEW_SCHEMAS) {
      await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${schema}"."activity_logs" (
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

    // 2) Widen action everywhere (only if the table exists in that schema).
    for (const schema of ALL_AUDIT_SCHEMAS) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = '${schema}'
              AND table_name = 'activity_logs'
              AND column_name = 'action'
          ) THEN
            ALTER TABLE "${schema}"."activity_logs"
              ALTER COLUMN "action" TYPE VARCHAR(64);
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the tables this migration introduced.
    for (const schema of NEW_SCHEMAS) {
      await queryRunner.query(
        `DROP TABLE IF EXISTS "${schema}"."activity_logs" CASCADE;`,
      );
    }
    // Revert action width to 32 on the pre-existing schemas. Guard against rows
    // whose action already exceeds 32 chars (truncation would error) by only
    // narrowing when safe.
    const PRE_EXISTING = [
      'order_schema',
      'finance_schema',
      'identity_schema',
      'branch_schema',
      'integration_schema',
    ];
    for (const schema of PRE_EXISTING) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = '${schema}'
              AND table_name = 'activity_logs'
              AND column_name = 'action'
          ) AND NOT EXISTS (
            SELECT 1 FROM "${schema}"."activity_logs" WHERE length("action") > 32
          ) THEN
            ALTER TABLE "${schema}"."activity_logs"
              ALTER COLUMN "action" TYPE VARCHAR(32);
          END IF;
        END $$;
      `);
    }
  }
}
