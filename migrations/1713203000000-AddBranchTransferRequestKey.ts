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
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = '${schema}'
            AND c.conname = 'UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY'
        ) THEN
          IF EXISTS (
            SELECT 1
            FROM pg_class cls
            JOIN pg_namespace n ON n.oid = cls.relnamespace
            WHERE n.nspname = '${schema}'
              AND cls.relname = 'UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY'
              AND cls.relkind = 'i'
          ) THEN
            BEGIN
              ALTER TABLE "${schema}"."branch_transfer_batches"
              ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
              UNIQUE USING INDEX "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY";
            EXCEPTION
              WHEN duplicate_object THEN
                NULL;
            END;
          ELSE
            BEGIN
              ALTER TABLE "${schema}"."branch_transfer_batches"
              ADD CONSTRAINT "UQ_BRANCH_TRANSFER_BATCHES_SOURCE_REQUEST_KEY"
              UNIQUE ("source_branch_id", "request_key");
            EXCEPTION
              WHEN duplicate_table THEN
                NULL;
              WHEN duplicate_object THEN
                NULL;
            END;
          END IF;
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
