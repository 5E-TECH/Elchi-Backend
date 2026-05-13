import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One user may only have one OPEN shift at a time. The service-level check
 * was a check-then-act pattern with no transaction, so concurrent openShift
 * calls could both insert. This adds a partial unique index in
 * finance_schema.shifts that the database enforces atomically.
 *
 * Fails loudly if active duplicates already exist; resolve them first.
 */
export class EnforceSingleOpenShift1714500000000 implements MigrationInterface {
  name = 'EnforceSingleOpenShift1714500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'finance_schema';

    const duplicates = await queryRunner.query(`
      SELECT opened_by, COUNT(*) AS open_count
      FROM "${schema}"."shifts"
      WHERE status = 'open' AND is_deleted = false
      GROUP BY opened_by
      HAVING COUNT(*) > 1;
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const sample = duplicates
        .slice(0, 10)
        .map((row: { opened_by: string; open_count: string }) =>
          `opened_by=${row.opened_by} (open=${row.open_count})`,
        )
        .join(', ');
      throw new Error(
        `Cannot add UNIQUE open-shift index — ${duplicates.length} users have multiple open shifts. Close duplicates first. Sample: ${sample}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_SHIFT_OPENED_BY_OPEN_UNIQUE"
      ON "${schema}"."shifts" ("opened_by")
      WHERE status = 'open' AND is_deleted = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'finance_schema';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_SHIFT_OPENED_BY_OPEN_UNIQUE";`,
    );
  }
}
