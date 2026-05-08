import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSentAtToBranchTransferBatchItems1713500000000 implements MigrationInterface {
  name = 'AddSentAtToBranchTransferBatchItems1713500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DB_SCHEMA_ORDER || 'order_schema';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batch_items"
      ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DB_SCHEMA_ORDER || 'order_schema';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batch_items"
      DROP COLUMN IF EXISTS "sent_at"
    `);
  }
}
