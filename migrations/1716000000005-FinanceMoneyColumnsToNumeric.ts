import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Convert the finance money subsystem from `double precision` (float) to exact
 * `numeric(14,2)`, matching user_salary / operator_earning / operator_payment
 * (already numeric) and the order money columns (migration ...004).
 *
 * Float accumulates rounding drift on every balance update
 * (`balance += amount`) and on the running P&L ledger
 * (`balance_after = balance_before + amount`). check-cashbox-invariant.ts even
 * carries an EPSILON tolerance to mask this "binary-float noise"; fixed-point
 * makes the invariant exact.
 *
 * Tables / columns (all in finance_schema):
 *   cashboxes:                balance, balance_cash, balance_card  (DEFAULT 0)
 *   cashbox_history:          amount, balance_after,
 *                             balance_cash_after, balance_card_after (nullable)
 *   financial_balance_history:amount, balance_before, balance_after
 *   shifts:                   opening/closing/total *_cash/_card (8 cols, DEFAULT 0)
 *
 * USING casts preserve existing values. Re-runnable: numeric→numeric is a no-op.
 */
export class FinanceMoneyColumnsToNumeric1716000000005 implements MigrationInterface {
  name = 'FinanceMoneyColumnsToNumeric1716000000005';

  private async toNumeric(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    opts: { default0?: boolean } = {},
  ): Promise<void> {
    const t = `"finance_schema"."${table}"`;
    if (opts.default0) {
      await queryRunner.query(
        `ALTER TABLE ${t} ALTER COLUMN "${column}" DROP DEFAULT;`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE ${t} ALTER COLUMN "${column}" TYPE numeric(14,2) USING "${column}"::numeric(14,2);`,
    );
    if (opts.default0) {
      await queryRunner.query(
        `ALTER TABLE ${t} ALTER COLUMN "${column}" SET DEFAULT 0;`,
      );
    }
  }

  private async toFloat(
    queryRunner: QueryRunner,
    table: string,
    column: string,
    opts: { default0?: boolean } = {},
  ): Promise<void> {
    const t = `"finance_schema"."${table}"`;
    if (opts.default0) {
      await queryRunner.query(
        `ALTER TABLE ${t} ALTER COLUMN "${column}" DROP DEFAULT;`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE ${t} ALTER COLUMN "${column}" TYPE double precision USING "${column}"::double precision;`,
    );
    if (opts.default0) {
      await queryRunner.query(
        `ALTER TABLE ${t} ALTER COLUMN "${column}" SET DEFAULT 0;`,
      );
    }
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.toNumeric(queryRunner, 'cashboxes', 'balance', {
      default0: true,
    });
    await this.toNumeric(queryRunner, 'cashboxes', 'balance_cash', {
      default0: true,
    });
    await this.toNumeric(queryRunner, 'cashboxes', 'balance_card', {
      default0: true,
    });

    await this.toNumeric(queryRunner, 'cashbox_history', 'amount');
    await this.toNumeric(queryRunner, 'cashbox_history', 'balance_after');
    await this.toNumeric(queryRunner, 'cashbox_history', 'balance_cash_after');
    await this.toNumeric(queryRunner, 'cashbox_history', 'balance_card_after');

    await this.toNumeric(queryRunner, 'financial_balance_history', 'amount');
    await this.toNumeric(
      queryRunner,
      'financial_balance_history',
      'balance_before',
    );
    await this.toNumeric(
      queryRunner,
      'financial_balance_history',
      'balance_after',
    );

    for (const col of [
      'opening_balance_cash',
      'opening_balance_card',
      'closing_balance_cash',
      'closing_balance_card',
      'total_income_cash',
      'total_income_card',
      'total_expense_cash',
      'total_expense_card',
    ]) {
      await this.toNumeric(queryRunner, 'shifts', col, { default0: true });
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.toFloat(queryRunner, 'cashboxes', 'balance', { default0: true });
    await this.toFloat(queryRunner, 'cashboxes', 'balance_cash', {
      default0: true,
    });
    await this.toFloat(queryRunner, 'cashboxes', 'balance_card', {
      default0: true,
    });

    await this.toFloat(queryRunner, 'cashbox_history', 'amount');
    await this.toFloat(queryRunner, 'cashbox_history', 'balance_after');
    await this.toFloat(queryRunner, 'cashbox_history', 'balance_cash_after');
    await this.toFloat(queryRunner, 'cashbox_history', 'balance_card_after');

    await this.toFloat(queryRunner, 'financial_balance_history', 'amount');
    await this.toFloat(
      queryRunner,
      'financial_balance_history',
      'balance_before',
    );
    await this.toFloat(
      queryRunner,
      'financial_balance_history',
      'balance_after',
    );

    for (const col of [
      'opening_balance_cash',
      'opening_balance_card',
      'closing_balance_cash',
      'closing_balance_card',
      'total_income_cash',
      'total_income_card',
      'total_expense_cash',
      'total_expense_card',
    ]) {
      await this.toFloat(queryRunner, 'shifts', col, { default0: true });
    }
  }
}
