import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParentOrderIdToOrders1713000000000 implements MigrationInterface {
  name = 'AddParentOrderIdToOrders1713000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      ADD COLUMN IF NOT EXISTS "parent_order_id" bigint
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema =
      (queryRunner.connection.options as { schema?: string }).schema ?? 'public';

    await queryRunner.query(`
      ALTER TABLE "${schema}"."orders"
      DROP COLUMN IF EXISTS "parent_order_id"
    `);
  }
}
