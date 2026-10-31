import { ExpenseCategory, FinancialSource_type } from '@app/common';
import {
  EXPENSE_CATEGORY_LABEL_UZ,
  FINANCIAL_BALANCE_EXPORT_COLUMNS,
  toFinancialBalanceExportRow,
} from './financial-balance.util';

/** ljVOuNz4 — moliyaviy balans eksportida «Kategoriya» ustuni. */
describe('ljVOuNz4 — daftar eksportidagi kategoriya', () => {
  const row = (extra: Record<string, unknown>) =>
    toFinancialBalanceExportRow(
      { id: '1', amount: -5000, source_type: 'manual_expense', ...extra },
      new Map(),
    ).category;

  it('«Kategoriya» ustuni bor', () => {
    expect(FINANCIAL_BALANCE_EXPORT_COLUMNS.map((c) => c.key)).toContain(
      'category',
    );
  });

  it('18 kategoriyaning hammasiga o`zbekcha nom', () => {
    expect(Object.keys(EXPENSE_CATEGORY_LABEL_UZ).sort()).toEqual(
      Object.values(ExpenseCategory).sort(),
    );
  });

  it('kategoriyali qator — nomi', () => {
    expect(row({ expense_category: 'fuel' })).toBe("Yoqilg'i");
  });

  it('kategoriyasiz chiqim — «Kategoriyasiz», «Boshqa» emas', () => {
    expect(row({ expense_category: null })).toBe('Kategoriyasiz');
  });

  it.each([
    [FinancialSource_type.SALARY, 'Oylik/maosh'],
    [FinancialSource_type.SELL_EXTRA_COST, 'Kuryer haqi'],
    [FinancialSource_type.CANCEL_EXTRA_COST, 'Kuryer haqi'],
  ])('eski %s qatori — manbadan keladigan ma`no', (source_type, label) => {
    expect(row({ expense_category: null, source_type })).toBe(label);
  });

  it.each([
    FinancialSource_type.SELL_PROFIT,
    FinancialSource_type.MANUAL_INCOME,
    FinancialSource_type.CORRECTION,
  ])('xarajat bo`lmagan %s — bo`sh', (source_type) => {
    expect(row({ amount: 100, source_type })).toBe('');
  });
});
