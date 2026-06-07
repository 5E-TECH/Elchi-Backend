import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-attempt idempotency epoch for cashbox_history.
 *
 * The idempotency unique index (cashbox_id, source_type, source_id,
 * operation_type) protects against duplicate RMQ/outbox deliveries of the SAME
 * finance event. But it also blocked a legitimate RE-application of money when
 * an order goes sell → rollback (CORRECTION reversal) → sell again: the second
 * SELL collided with the first on the same key and was silently skipped, so the
 * cashbox ended up short of what the order claimed. Likewise a second rollback
 * collided with the first CORRECTION.
 *
 * `dedup_epoch` adds a per-attempt discriminator (a timestamp token assigned
 * once per sale / per rollback by order-service). Duplicate deliveries of one
 * attempt share the epoch → still deduped. A fresh attempt after a rollback
 * carries a new epoch → applies correctly. The original rows are NEVER deleted,
 * so the full audit trail (SELL, CORRECTION [ROLLBACK], SELL, …) is preserved.
 *
 * Non-sale callers leave it as '' (the default), so their behaviour is
 * unchanged — '' collides with '' exactly like before.
 */
export class AddCashboxDedupEpoch1716000000001 implements MigrationInterface {
  name = 'AddCashboxDedupEpoch1716000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "finance_schema"."cashbox_history" ADD COLUMN IF NOT EXISTS "dedup_epoch" varchar NOT NULL DEFAULT '';`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_IDEMPOTENT";`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_IDEMPOTENT" ` +
        `ON "finance_schema"."cashbox_history" ` +
        `("cashbox_id", "source_type", "source_id", "operation_type", "dedup_epoch") ` +
        `WHERE "source_id" IS NOT NULL AND "is_deleted" = false;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_IDEMPOTENT";`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_IDEMPOTENT" ` +
        `ON "finance_schema"."cashbox_history" ` +
        `("cashbox_id", "source_type", "source_id", "operation_type") ` +
        `WHERE "source_id" IS NOT NULL AND "is_deleted" = false;`,
    );
    await queryRunner.query(
      `ALTER TABLE "finance_schema"."cashbox_history" DROP COLUMN IF EXISTS "dedup_epoch";`,
    );
  }
}
