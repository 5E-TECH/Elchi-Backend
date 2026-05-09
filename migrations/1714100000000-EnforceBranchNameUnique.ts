import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a partial unique index on LOWER(TRIM(name)) for active branches.
 * Catches case-variant duplicates (e.g. "Toshkent" vs "TOSHKENT") that the
 * old exact-string check missed.
 *
 * Fails loudly if active duplicates already exist; resolve them first.
 */
export class EnforceBranchNameUnique1714100000000 implements MigrationInterface {
  name = 'EnforceBranchNameUnique1714100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    const duplicates = await queryRunner.query(`
      SELECT LOWER(TRIM(name)) AS normalized, COUNT(*) AS dup_count, MIN(name) AS sample
      FROM "${schema}"."branches"
      WHERE is_deleted = false
      GROUP BY LOWER(TRIM(name))
      HAVING COUNT(*) > 1;
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const sample = duplicates
        .slice(0, 10)
        .map((row: { normalized: string; dup_count: string; sample: string }) =>
          `"${row.sample}" (count=${row.dup_count})`,
        )
        .join(', ');
      throw new Error(
        `Cannot add UNIQUE branch name index — found ${duplicates.length} duplicate active names. Resolve before running. Sample: ${sample}`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_NAME_UNIQUE_ACTIVE"
      ON "${schema}"."branches" (LOWER(TRIM(name)))
      WHERE is_deleted = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_NAME_UNIQUE_ACTIVE";`,
    );
  }
}
