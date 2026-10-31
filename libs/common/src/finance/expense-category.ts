import { ExpenseCategory, FinancialSource_type } from '../enums';

/**
 * ljVOuNz4 — P&L daftari (`financial_balance_history`) yozuvining kategoriya
 * qoidalari: gateway (majburiylik) va finance-service (qatorga yozish) bitta
 * joydan o'qiydi.
 *
 *   manual_expense — 18 talik to'liq ro'yxat;
 *   bills          — ma'noli qism (`BILLS_EXPENSE_CATEGORIES`);
 *   salary         — so'ralmaydi, avtomatik `salary`;
 *   qolganlari     — so'ralmaydi, NULL (yuborilgan qiymat e'tiborsiz).
 */

/** `bills`: "kommunal" o'zi qaysi hisob ekanini aytmaydi. */
export const BILLS_EXPENSE_CATEGORIES: readonly ExpenseCategory[] =
  Object.freeze([
    ExpenseCategory.UTILITIES,
    ExpenseCategory.COMMUNICATION,
    ExpenseCategory.RENT,
    ExpenseCategory.TAX,
    ExpenseCategory.BANK_FEE,
    ExpenseCategory.OTHER,
  ]);

/** Ro'yxat filtridagi «Kategoriyasiz» qiymati. */
export const EXPENSE_CATEGORY_NONE = 'none';

const ALL_CATEGORIES = Object.freeze(Object.values(ExpenseCategory));

/** Kategoriya so'raladigan manbalar va ularning ruxsat etilgan qiymatlari. */
const ASKED_SOURCES: ReadonlyMap<
  FinancialSource_type,
  readonly ExpenseCategory[]
> = new Map([
  [FinancialSource_type.MANUAL_EXPENSE, ALL_CATEGORIES],
  [FinancialSource_type.BILLS, BILLS_EXPENSE_CATEGORIES],
]);

/**
 * Daftar qatori kategoriyasiz bo'lsa, manbaning o'zidan keladigan ma'no
 * (eski qatorlar, hisobot va eksport uchun).
 */
export const LEDGER_SOURCE_CATEGORY: Readonly<
  Partial<Record<FinancialSource_type, ExpenseCategory>>
> = Object.freeze({
  [FinancialSource_type.SALARY]: ExpenseCategory.SALARY,
  [FinancialSource_type.SELL_EXTRA_COST]: ExpenseCategory.COURIER_FEE,
  [FinancialSource_type.CANCEL_EXTRA_COST]: ExpenseCategory.COURIER_FEE,
});

export const isExpenseCategory = (value: unknown): value is ExpenseCategory =>
  (ALL_CATEGORIES as readonly unknown[]).includes(value);

/** Manba kategoriya so'raydimi (`manual_expense`, `bills`). */
export const ledgerSourceAsksCategory = (
  source_type: FinancialSource_type,
): boolean => ASKED_SOURCES.has(source_type);

/**
 * Manba + yuborilgan qiymat → qatorga yoziladigan kategoriya.
 * `message` — qiymat shu manbaga mos emas (400). `missing` — so'raladigan
 * manbada qiymat yo'q: gateway kalit bilan rad etadi, ichki chaqiruvchilar
 * (investor to'lovi, sotuv oqimlari) kategoriyasiz o'tadi.
 */
export function resolveLedgerExpenseCategory(
  source_type: FinancialSource_type,
  value: unknown,
): { category: ExpenseCategory | null; missing: boolean; message?: string } {
  if (source_type === FinancialSource_type.SALARY) {
    return { category: ExpenseCategory.SALARY, missing: false };
  }
  const allowed = ASKED_SOURCES.get(source_type);
  if (!allowed) {
    return { category: null, missing: false };
  }
  if (value === undefined || value === null || value === '') {
    return { category: null, missing: true };
  }
  if (!(allowed as readonly unknown[]).includes(value)) {
    return {
      category: null,
      missing: false,
      message: `Bu kategoriya ${source_type} manbasiga mos emas`,
    };
  }
  return { category: value as ExpenseCategory, missing: false };
}
