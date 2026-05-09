import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates idempotency_keys table in the current schema. This migration must
 * be run for every service schema that wires up IdempotencyModule (set
 * DB_SCHEMA env to that schema before running).
 */
export class CreateIdempotencyKeysTable1713700000000 implements MigrationInterface {
  name = 'CreateIdempotencyKeysTable1713700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."idempotency_keys" (
        "id" BIGSERIAL PRIMARY KEY,
        "key" VARCHAR(200) NOT NULL,
        "pattern" VARCHAR(128) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'in_progress',
        "response" JSONB,
        "error" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "completed_at" TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_IDEMPOTENCY_KEY_UNIQUE"
      ON "${schema}"."idempotency_keys" ("key");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_IDEMPOTENCY_PATTERN"
      ON "${schema}"."idempotency_keys" ("pattern");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_IDEMPOTENCY_CREATED"
      ON "${schema}"."idempotency_keys" ("created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${schema}"."idempotency_keys" CASCADE;`,
    );
  }
}
