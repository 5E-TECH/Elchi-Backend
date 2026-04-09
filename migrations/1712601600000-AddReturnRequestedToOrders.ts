import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReturnRequestedToOrders1712601600000 implements MigrationInterface {
  name = 'AddReturnRequestedToOrders1712601600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "return_requested" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ORDERS_RETURN_REQUESTED" ON "orders" ("return_requested")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ORDERS_RETURN_REQUESTED"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "return_requested"`,
    );
  }
}
