import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOperatorIdToOrders1712515200000 implements MigrationInterface {
  name = 'AddOperatorIdToOrders1712515200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "operator_id" bigint NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ORDERS_OPERATOR_ID" ON "orders" ("operator_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ORDERS_OPERATOR_ID"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "operator_id"`,
    );
  }
}
