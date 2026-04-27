import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReceivedByUserIdToTransferBatches1713205000000
  implements MigrationInterface
{
  name = 'AddReceivedByUserIdToTransferBatches1713205000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      ADD COLUMN IF NOT EXISTS "received_by_user_id" bigint NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_BRANCH_TRANSFER_BATCHES_RECEIVED_BY_USER_ID"
      ON "${schema}"."branch_transfer_batches" ("received_by_user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."IDX_BRANCH_TRANSFER_BATCHES_RECEIVED_BY_USER_ID"
    `);
    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      DROP COLUMN IF EXISTS "received_by_user_id"
    `);
  }
}
