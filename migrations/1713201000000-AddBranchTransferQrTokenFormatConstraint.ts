import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchTransferQrTokenFormatConstraint1713201000000
  implements MigrationInterface
{
  name = 'AddBranchTransferQrTokenFormatConstraint1713201000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_schema = '${schema}'
            AND table_name = 'branch_transfer_batches'
            AND constraint_name = 'CHK_BRANCH_TRANSFER_BATCH_QR_TOKEN_DIRECTION'
        ) THEN
          ALTER TABLE "${schema}"."branch_transfer_batches"
          ADD CONSTRAINT "CHK_BRANCH_TRANSFER_BATCH_QR_TOKEN_DIRECTION"
          CHECK (
            qr_code_token ~ '^(BTB|BTR)-[A-Za-z0-9]{6,64}$'
            AND (
              (direction = 'FORWARD' AND qr_code_token LIKE 'BTB-%')
              OR
              (direction = 'RETURN' AND qr_code_token LIKE 'BTR-%')
            )
          );
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branch_transfer_batches"
      DROP CONSTRAINT IF EXISTS "CHK_BRANCH_TRANSFER_BATCH_QR_TOKEN_DIRECTION"
    `);
  }
}
