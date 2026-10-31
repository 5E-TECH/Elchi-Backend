import {
  aggregateExpenseReport,
  EXPENSE_REPORT_LEDGER_SOURCES,
  buildExpenseReportSql,
} from './expense-report';

const TABLES = {
  ledger: 'finance_schema.financial_balance_history',
  history: 'finance_schema.cashbox_history',
  cashbox: 'finance_schema.cashboxes',
  categories: 'finance_schema.cashbox_expense_categories',
};

/**
 * ljVOuNz4 — xarajat hisoboti: jamlash qoidalari (sof funksiya). Haqiqiy
 * jadvallar bilan — `expense-report.ljVOuNz4.pg.spec.ts`.
 */
describe('ljVOuNz4 — aggregateExpenseReport', () => {
  it('⭐ numeric SATR keladi: konkatenatsiya yo`q, kategoriya jamlari jadval jamiga teng', () => {
    const report = aggregateExpenseReport([
      { category: 'fuel', total_amount: '12.50', transaction_count: 2 },
      { category: 'rent', total_amount: '5', transaction_count: '1' },
      { category: null, total_amount: '0.10', transaction_count: 1 },
    ]);

    expect(report.total_amount).toBe(17.6);
    expect(report.transaction_count).toBe(4);
    const sum =
      report.categories.reduce((acc, row) => acc + row.total_amount, 0) +
      report.uncategorized.total_amount;
    expect(Math.round(sum * 100) / 100).toBe(report.total_amount);
  });

  it('⭐ NULL "Kategoriyasiz" da AYRIM, `other` ga qo`shilmaydi', () => {
    const report = aggregateExpenseReport([
      { category: 'other', total_amount: '100', transaction_count: 1 },
      { category: null, total_amount: '300', transaction_count: 3 },
    ]);

    expect(report.categories).toEqual([
      {
        category: 'other',
        total_amount: 100,
        transaction_count: 1,
        percentage: 25,
      },
    ]);
    expect(report.uncategorized).toEqual({
      total_amount: 300,
      transaction_count: 3,
      percentage: 75,
    });
  });

  it('kattasi tepada; bo`sh davr — nollar, 0 ga bo`linmaydi', () => {
    const report = aggregateExpenseReport([
      { category: 'rent', total_amount: '5', transaction_count: 1 },
      { category: 'fuel', total_amount: '50', transaction_count: 1 },
    ]);
    expect(report.categories.map((row) => row.category)).toEqual([
      'fuel',
      'rent',
    ]);

    expect(aggregateExpenseReport([])).toEqual({
      total_amount: 0,
      transaction_count: 0,
      categories: [],
      uncategorized: { total_amount: 0, transaction_count: 0, percentage: 0 },
    });
  });

  it('`extra_cost` qaytarilgani (manfiy yig`indi) jamni kamaytiradi', () => {
    const report = aggregateExpenseReport([
      { category: 'courier_fee', total_amount: '0', transaction_count: 2 },
      { category: 'fuel', total_amount: '10', transaction_count: 1 },
    ]);
    expect(report.total_amount).toBe(10);
  });
});

describe('ljVOuNz4 — buildExpenseReportSql', () => {
  const sql = buildExpenseReportSql(TABLES, {}).sql;

  it('kassalar orasidagi ko`chirishlar SQL`da yo`q', () => {
    for (const source of [
      'courier_payment',
      'market_payment',
      'branch_to_main',
    ]) {
      expect(sql).not.toContain(source);
    }
  });

  it('daftar manbalari — faqat xarajat', () => {
    expect([...EXPENSE_REPORT_LEDGER_SOURCES].sort()).toEqual([
      'bills',
      'cancel_extra_cost',
      'manual_expense',
      'salary',
      'sell_extra_cost',
    ]);
  });

  it('sana filtri parametr bilan', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    const built = buildExpenseReportSql(TABLES, { start: from, end: to });
    expect(built.params).toEqual([from, to]);
    expect(built.sql).toContain('$1');
    expect(built.sql).toContain('$2');
  });
});
