import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert operator-commission and investor-share money/percentage columns from
 * float (double precision) to numeric, for exact fixed-point financial values.
 *
 * float can't represent decimal money exactly, so commissions / profit shares /
 * salaries accumulated rounding drift and SUM reports didn't reconcile to the
 * tiyin. numeric(14,2) holds money (and the dual-purpose commission_value, which
 * is a flat amount when FIXED); numeric(5,2) holds the pure investor percentage.
 *
 * USING col::numeric rounds existing values to the target scale on conversion.
 * Cross-schema by fully-qualified name (runs on the single db-prepare datasource).
 */
export class NumericMoneyForOperatorInvestor1715900000000 implements MigrationInterface {
  name = 'NumericMoneyForOperatorInvestor1715900000000';

  private static readonly MONEY: Array<[string, string]> = [
    ['identity_schema.admins', 'commission_value'],
    ['finance_schema.operator_earnings', 'amount'],
    ['finance_schema.operator_earnings', 'commission_value'],
    ['finance_schema.operator_earnings', 'order_total_price'],
    ['finance_schema.operator_payments', 'amount'],
    ['finance_schema.user_salaries', 'salary_amount'],
    ['finance_schema.user_salaries', 'have_to_pay'],
    ['investor_schema.investments', 'amount'],
    ['investor_schema.profit_shares', 'amount'],
  ];

  // table, column, precision, scale
  private static readonly PERCENT: Array<[string, string]> = [
    ['investor_schema.profit_shares', 'percentage'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [
      table,
      col,
    ] of NumericMoneyForOperatorInvestor1715900000000.MONEY) {
      const [schema, name] = table.split('.');
      await queryRunner.query(
        `ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${col}" TYPE numeric(14,2) USING "${col}"::numeric(14,2);`,
      );
    }
    for (const [
      table,
      col,
    ] of NumericMoneyForOperatorInvestor1715900000000.PERCENT) {
      const [schema, name] = table.split('.');
      await queryRunner.query(
        `ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${col}" TYPE numeric(5,2) USING "${col}"::numeric(5,2);`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const all = [
      ...NumericMoneyForOperatorInvestor1715900000000.MONEY,
      ...NumericMoneyForOperatorInvestor1715900000000.PERCENT,
    ];
    for (const [table, col] of all) {
      const [schema, name] = table.split('.');
      await queryRunner.query(
        `ALTER TABLE "${schema}"."${name}" ALTER COLUMN "${col}" TYPE double precision USING "${col}"::double precision;`,
      );
    }
  }
}
