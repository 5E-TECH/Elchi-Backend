import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cashbox history must be idempotent per business event. RMQ uses
 * at-least-once delivery, so the same finance.cashbox.update_balance event can
 * arrive multiple times — without this guard, the balance gets bumped twice
 * and two history rows appear.
 *
 * App-level pre-check in updateBalance() already catches replays under the
 * row lock, but this partial unique index is the DB-level safety belt:
 * any code path that bypasses updateBalance (manual SQL, future endpoints)
 * still cannot create a duplicate.
 *
 * Partial — only enforced when source_id IS NOT NULL. Manual adjustments
 * (salaries, free-form expense) have NULL source_id and remain non-idempotent
 * by design.
 *
 * Fails loudly if active duplicates already exist; resolve them first.
 */
export class EnforceCashboxHistoryIdempotency1714600000000
  implements MigrationInterface
{
  name = 'EnforceCashboxHistoryIdempotency1714600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'finance_schema';

    const duplicates = await queryRunner.query(`
      SELECT cashbox_id, source_type, source_id, operation_type, COUNT(*) AS dup_count
      FROM "${schema}"."cashbox_history"
      WHERE source_id IS NOT NULL AND is_deleted = false
      GROUP BY cashbox_id, source_type, source_id, operation_type
      HAVING COUNT(*) > 1;
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const sample = duplicates
        .slice(0, 10)
        .map(
          (row: {
            cashbox_id: string;
            source_type: string;
            source_id: string;
            operation_type: string;
            dup_count: string;
          }) =>
            `cashbox=${row.cashbox_id} ${row.source_type}/${row.source_id} ${row.operation_type} (x${row.dup_count})`,
        )
        .join(', ');
      throw new Error(
        `Cannot add UNIQUE cashbox_history index — ${duplicates.length} duplicate groups exist. Soft-delete the duplicates first. Sample: ${sample}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_IDEMPOTENT"
      ON "${schema}"."cashbox_history" ("cashbox_id", "source_type", "source_id", "operation_type")
      WHERE source_id IS NOT NULL AND is_deleted = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'finance_schema';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_CASHBOX_HISTORY_IDEMPOTENT";`,
    );
  }
}
