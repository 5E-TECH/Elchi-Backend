import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Search documents are queried with ILIKE '%term%'. Without trigram indexes
 * this forces a full table scan on every search — fine while the corpus is
 * small, painfully slow as it grows.
 *
 * pg_trgm exposes trigram-based GIN indexes that ILIKE can use. The query
 * planner picks them up automatically — no application change needed.
 */
export class AddSearchTrigramIndexes1714700000000 implements MigrationInterface {
  name = 'AddSearchTrigramIndexes1714700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'search_schema';

    // Extension lives in the schema's search_path; CREATE EXTENSION places it
    // in whichever schema the role can write to. Safe to call repeatedly.
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEARCH_DOC_TITLE_TRGM"
      ON "${schema}"."search_documents"
      USING gin (title gin_trgm_ops);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEARCH_DOC_CONTENT_TRGM"
      ON "${schema}"."search_documents"
      USING gin (content gin_trgm_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'search_schema';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_SEARCH_DOC_CONTENT_TRGM";`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."IDX_SEARCH_DOC_TITLE_TRGM";`,
    );
    // We intentionally do NOT drop the extension — other schemas may depend
    // on it.
  }
}
