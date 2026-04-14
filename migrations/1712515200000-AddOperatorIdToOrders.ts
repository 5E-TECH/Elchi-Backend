import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOperatorIdToOrders1712515200000 implements MigrationInterface {
  name = 'AddOperatorIdToOrders1712515200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(
      `ALTER TABLE "${schema}"."orders" ADD COLUMN IF NOT EXISTS "operator_id" bigint NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ORDERS_OPERATOR_ID" ON "${schema}"."orders" ("operator_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = (queryRunner.connection.options as { schema?: string }).schema ?? 'public';
    await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."IDX_ORDERS_OPERATOR_ID"`);
    await queryRunner.query(
      `ALTER TABLE "${schema}"."orders" DROP COLUMN IF EXISTS "operator_id"`,
    );
  }
}
