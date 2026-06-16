import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `finance_schema.outbox_events` so finance-service can publish via the
 * transactional outbox (Faza 2a — split-brain fix).
 *
 * Background: every migration in this repo is recorded once in
 * `order_schema.migrations` (db-prepare runs migrations only against
 * order_schema) and hardcodes its own target schema. The original outbox table
 * migration (1713800000000) used the *connection* schema, so it only created
 * `order_schema.outbox_events`. finance now also needs its own outbox table, so
 * this migration creates it explicitly in finance_schema.
 *
 * finance enqueues `order.settlement.advance` events here INSIDE the same
 * transaction that moves the cashbox, so the per-order FIFO settlement ledger is
 * advanced with at-least-once, retried, DLQ-backed delivery instead of the old
 * best-effort try/catch (which silently lost the advance on any failure and
 * re-opened the split-brain between cashbox balances and order_settlement).
 */
export class CreateFinanceOutboxEvents1716000000012
  implements MigrationInterface
{
  name = 'CreateFinanceOutboxEvents1716000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."outbox_events" (
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
      CREATE INDEX IF NOT EXISTS "IDX_FINANCE_OUTBOX_DUE"
      ON "finance_schema"."outbox_events" ("status", "scheduled_at");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FINANCE_OUTBOX_TARGET"
      ON "finance_schema"."outbox_events" ("target");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."outbox_events" CASCADE;`,
    );
  }
}
