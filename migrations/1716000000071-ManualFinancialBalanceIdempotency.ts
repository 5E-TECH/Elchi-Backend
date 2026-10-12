import { MigrationInterface, QueryRunner } from 'typeorm';

export class ManualFinancialBalanceIdempotency1716000000071 implements MigrationInterface {
  name = 'ManualFinancialBalanceIdempotency1716000000071';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_FBH_SOURCE_NO_ORDER_KEY"
      ON "finance_schema"."financial_balance_history" ("source_type", "dedup_key")
      WHERE "order_id" IS NULL AND "dedup_key" <> ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_FBH_SOURCE_NO_ORDER_KEY"`,
    );
  }
}
