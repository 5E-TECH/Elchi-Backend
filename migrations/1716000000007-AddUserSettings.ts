import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user UI preferences (theme, language, sidebar, dashboard widget
 * visibility, ...) stored opaquely as JSONB on identity_schema.admins.
 */
export class AddUserSettings1716000000007 implements MigrationInterface {
  name = 'AddUserSettings1716000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "settings" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "settings"`,
    );
  }
}
