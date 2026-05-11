import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateBranchTypeToPickupRegionalHybrid1714300000000 implements MigrationInterface {
  name = 'MigrateBranchTypeToPickupRegionalHybrid1714300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'branch_schema';

    await queryRunner.query(`
      ALTER TYPE "${schema}"."branches_type_enum" RENAME TO "branches_type_enum_old";
    `);

    await queryRunner.query(`
      CREATE TYPE "${schema}"."branches_type_enum" AS ENUM ('HQ', 'PICKUP', 'REGIONAL', 'HYBRID');
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type" DROP DEFAULT;
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type"
      TYPE "${schema}"."branches_type_enum"
      USING (
        CASE
          WHEN "type"::text = 'CITY' THEN 'PICKUP'
          WHEN "type"::text = 'DISTRICT' THEN 'PICKUP'
          WHEN "type"::text = 'REGIONAL' THEN 'REGIONAL'
          WHEN "type"::text = 'HQ' THEN 'HQ'
          ELSE 'PICKUP'
        END
      )::"${schema}"."branches_type_enum";
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type" SET DEFAULT 'PICKUP';
    `);

    await queryRunner.query(`
      DROP TYPE "${schema}"."branches_type_enum_old";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = 'branch_schema';

    await queryRunner.query(`
      ALTER TYPE "${schema}"."branches_type_enum" RENAME TO "branches_type_enum_new";
    `);

    await queryRunner.query(`
      CREATE TYPE "${schema}"."branches_type_enum" AS ENUM ('HQ', 'CITY', 'REGIONAL', 'DISTRICT');
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type" DROP DEFAULT;
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type"
      TYPE "${schema}"."branches_type_enum"
      USING (
        CASE
          WHEN "type"::text = 'HYBRID' THEN 'CITY'
          WHEN "type"::text = 'PICKUP' THEN 'CITY'
          WHEN "type"::text = 'REGIONAL' THEN 'REGIONAL'
          WHEN "type"::text = 'HQ' THEN 'HQ'
          ELSE 'CITY'
        END
      )::"${schema}"."branches_type_enum";
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."branches"
      ALTER COLUMN "type" SET DEFAULT 'DISTRICT';
    `);

    await queryRunner.query(`
      DROP TYPE "${schema}"."branches_type_enum_new";
    `);
  }
}
