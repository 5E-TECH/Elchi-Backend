import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchTransferRequestKey1713203000000 implements MigrationInterface {
  name = 'AddBranchTransferRequestKey1713203000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      ADD COLUMN IF NOT EXISTS "request_key" character varying(80)
    `);

    await queryRunner.query(`
      UPDATE "${schema}"."branch_transfer_batches"
      SET "request_key" = 'LEGACY-' || id::text
      WHERE "request_key" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      ALTER COLUMN "request_key" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_REQUEST_KEY"
      ON "${schema}"."branch_transfer_batches" ("request_key")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_schema = '${schema}'
            AND table_name = 'branch_transfer_batches'
            AND constraint_name = 'UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY'
        ) THEN
          ALTER TABLE "${schema}"."branch_transfer_batches"
          ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
          UNIQUE ("source_branch_id", "request_key");
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      DROP CONSTRAINT IF EXISTS "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_REQUEST_KEY"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      DROP COLUMN IF EXISTS "request_key"
    `);
  }
}
