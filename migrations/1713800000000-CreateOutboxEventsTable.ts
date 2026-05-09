import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates outbox_events table in the current schema. Run for every service
 * schema that wires up OutboxModule (set DB_SCHEMA env to that schema).
 */
export class CreateOutboxEventsTable1713800000000 implements MigrationInterface {
  name = 'CreateOutboxEventsTable1713800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."outbox_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "target" VARCHAR(64) NOT NULL,
        "pattern" VARCHAR(128) NOT NULL,
        "payload" JSONB NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "last_error" TEXT,
        "scheduled_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "published_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OUTBOX_DUE"
      ON "${schema}"."outbox_events" ("status", "scheduled_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OUTBOX_TARGET"
      ON "${schema}"."outbox_events" ("target");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${schema}"."outbox_events" CASCADE;`,
    );
  }
}
