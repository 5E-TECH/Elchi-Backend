import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMarketCancelledHandoverQrRequired1716000000016
  implements MigrationInterface
{
  name = 'AddMarketCancelledHandoverQrRequired1716000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "cancelled_handover_qr_required"
      boolean NOT NULL DEFAULT true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP COLUMN IF EXISTS "cancelled_handover_qr_required";
    `);
  }
}
