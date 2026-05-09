import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the per-(branch_id, user_id) unique constraint with a per-user
 * partial unique index that only applies to active (is_deleted=false) rows.
 * Enforces the application-level rule "one user belongs to exactly one branch"
 * at the database level, while still allowing a user to be re-assigned after
 * soft-deletion of their previous BranchUser row.
 *
 * Fails loudly if there are duplicate active assignments — the operator must
 * resolve conflicts before running this migration.
 */
export class StrengthenBranchUserUnique1714000000000 implements MigrationInterface {
  name = 'StrengthenBranchUserUnique1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    const duplicates = await queryRunner.query(`
      SELECT user_id, COUNT(*) AS active_count
      FROM "${schema}"."branch_users"
      WHERE is_deleted = false
      GROUP BY user_id
      HAVING COUNT(*) > 1;
    `);

    if (Array.isArray(duplicates) && duplicates.length > 0) {
      const sample = duplicates
        .slice(0, 10)
        .map((row: { user_id: string; active_count: string }) =>
          `user_id=${row.user_id} (count=${row.active_count})`,
        )
        .join(', ');
      throw new Error(
        `Cannot add UNIQUE(user_id) — found ${duplicates.length} users with multiple active branch assignments. Resolve duplicates first. Sample: ${sample}`,
      );
    }

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_USER_UNIQUE";
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_USER_USER_UNIQUE_ACTIVE"
      ON "${schema}"."branch_users" ("user_id")
      WHERE is_deleted = false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_USER_USER_UNIQUE_ACTIVE";
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_BRANCH_USER_UNIQUE"
      ON "${schema}"."branch_users" ("branch_id", "user_id");
    `);
  }
}
