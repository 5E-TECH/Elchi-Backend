import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds branch_id column to logistics_schema.posts so courier batches can be
 * attributed to a branch (filial). Existing rows get NULL — they belong to
 * no branch and remain visible in HQ-level reports.
 */
export class AddBranchIdToPosts1713900000000 implements MigrationInterface {
  name = 'AddBranchIdToPosts1713900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."posts"
      ADD COLUMN IF NOT EXISTS "branch_id" BIGINT NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_POST_BRANCH"
      ON "${schema}"."posts" ("branch_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_POST_BRANCH";`,
    );
    await queryRunner.query(
      `ALTER TABLE "${schema}"."posts" DROP COLUMN IF EXISTS "branch_id";`,
    );
  }
}
