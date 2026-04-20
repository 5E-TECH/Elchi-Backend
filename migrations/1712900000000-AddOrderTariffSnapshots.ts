import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderTariffSnapshots1712900000000 implements MigrationInterface {
  name = 'AddOrderTariffSnapshots1712900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "market_tariff" double precision
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "courier_tariff" double precision
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "courier_tariff"
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "market_tariff"
    `);
  }
}
