import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtraCostPermission1716000000024 implements MigrationInterface {
  name = 'AddExtraCostPermission1716000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      ADD COLUMN IF NOT EXISTS "can_add_extra_cost" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
      DROP COLUMN IF EXISTS "can_add_extra_cost";
    `);
  }
}
