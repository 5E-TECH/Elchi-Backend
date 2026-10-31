import { LEDGER_SOURCE_CATEGORY } from '@app/common/finance/expense-category';
import { ExpenseCategory, FinancialSource_type } from '@app/common/enums';

/**
 * ljVOuNz4 — xarajat kategoriyalari bo'yicha jamlama (Balans → Tahlil).
 * `GET /finance/financial-balance/expense-report`.
 *
 * Asos — P&L daftari; kassa jadvalidan faqat daftarga tushmagan qatorlar
 * qo'shiladi (IgR4FVsR dan oldingi qo'lda chiqimlar, `PATCH /cashbox/balance`).
 *
 *   • Kategoriya: `expense_category` bo'lsa o'zi, bo'lmasa juft kassa qatoridan
 *     (migratsiya 197 dan oldingi qo'lda chiqimlar: kassada kategoriya bor,
 *     daftar qatori NULL), bo'lmasa manbadan keladigan ma'no
 *     (`LEDGER_SOURCE_CATEGORY`), hech biri yo'q — «Kategoriyasiz», AYRIM
 *     (`uncategorized`), `other` ga qo'shilmaydi.
 *   • Kassalar orasidagi ko'chirishlar xarajat EMAS: kassa tomoni ruxsat
 *     ro'yxatida (`courier_payment`, `market_payment`, `branch_to_main` yo'q).
 *     Faqat MAIN va filial kassasi: kuryer/market kassasidagi `extra_cost`
 *     oyog'ining puli daftarda `sell_extra_cost` bo'lib turibdi.
 *   • Qo'shaloq yozuv bir marta: kassa qatorining daftardagi jufti uchta kalit
 *     bilan topiladi — `cashbox-history:<id>` (qo'lda chiqim),
 *     `operator-payment:<source_id>` (operator to'lovi), `dedup_epoch` (investor
 *     to'lovi: ikkala qatorda ham `investor-profit:<id>`).
 *   • `salary` kategoriyasi va `salary` manbasi aralashmaydi: kassadan
 *     "Xodimlar oyligi" bilan chiqim ham, operator to'lovi ham juftlik
 *     qoidasi bilan bir marta sanaladi.
 *   • Tuzatish (`correction`) xarajat emas, faqat `rollback-extra:*` —
 *     qaytarilgan `extra_cost`, Kuryer haqi jamidan ayriladi.
 */
export type ExpenseReportTables = {
  ledger: string;
  history: string;
  cashbox: string;
  categories: string;
};

export const EXPENSE_REPORT_LEDGER_SOURCES: readonly FinancialSource_type[] =
  Object.freeze([
    FinancialSource_type.MANUAL_EXPENSE,
    FinancialSource_type.BILLS,
    FinancialSource_type.SALARY,
    FinancialSource_type.SELL_EXTRA_COST,
    FinancialSource_type.CANCEL_EXTRA_COST,
  ]);

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part.replace(/"/g, '')}"`)
    .join('.');

const SOURCES_SQL = EXPENSE_REPORT_LEDGER_SOURCES.map(
  (source) => `'${source}'`,
).join(', ');

const SOURCE_CATEGORY_SQL = Object.entries(LEDGER_SOURCE_CATEGORY)
  .map(([source, category]) => `WHEN '${source}' THEN '${category}'`)
  .join(' ');

export function buildExpenseReportSql(
  tables: ExpenseReportTables,
  filter: { start?: Date | null; end?: Date | null },
) {
  const ledger = quote(tables.ledger);
  const history = quote(tables.history);
  const cashbox = quote(tables.cashbox);
  const categories = quote(tables.categories);

  // Ikkala SELECT ham ayni $1/$2 ni ishlatadi.
  const params: unknown[] = [];
  const conditions: Array<(column: string) => string> = [];
  if (filter.start) {
    params.push(filter.start);
    const ref = `$${params.length}`;
    conditions.push((column) => `AND ${column} >= ${ref}`);
  }
  if (filter.end) {
    params.push(filter.end);
    const ref = `$${params.length}`;
    conditions.push((column) => `AND ${column} <= ${ref}`);
  }
  const dateSql = (column: string) =>
    conditions.map((condition) => condition(column)).join(' ');

  const sql = `
    SELECT x.category, SUM(x.amount)::text AS total_amount,
      COUNT(*)::int AS transaction_count
    FROM (
      SELECT
        COALESCE(l."expense_category"::text,
          oc."ledger_category"::text,
          CASE WHEN o."expense_category_id" IS NOT NULL
            THEN '${ExpenseCategory.OTHER}' END,
          CASE l."source_type"::text
            ${SOURCE_CATEGORY_SQL}
            WHEN 'correction' THEN '${ExpenseCategory.COURIER_FEE}'
          END) AS category,
        -l."amount" AS amount
      FROM ${ledger} l
      LEFT JOIN ${history} o ON o."id" =
        substring(l."dedup_key" from '^cashbox-history:([0-9]+)$')::bigint
      LEFT JOIN ${categories} oc ON oc."id" = o."expense_category_id"
      WHERE l."is_deleted" = false
        ${dateSql('l."createdAt"')}
        AND (
          (l."amount" < 0 AND l."source_type"::text IN (${SOURCES_SQL}))
          OR (l."source_type" = 'correction'
            AND l."dedup_key" LIKE 'rollback-extra:%')
        )
      UNION ALL
      SELECT
        COALESCE(c."ledger_category"::text,
          CASE WHEN k."expense_category_id" IS NOT NULL
            THEN '${ExpenseCategory.OTHER}' END,
          CASE WHEN k."source_type" = 'salary'
            THEN '${ExpenseCategory.SALARY}' END) AS category,
        k."amount" AS amount
      FROM ${history} k
      JOIN ${cashbox} b ON b."id" = k."cashbox_id"
      LEFT JOIN ${categories} c ON c."id" = k."expense_category_id"
      WHERE k."is_deleted" = false
        ${dateSql('k."createdAt"')}
        AND k."operation_type" = 'expense'
        AND k."source_type" IN ('manual_expense', 'bills', 'salary')
        AND b."cashbox_type" IN ('main', 'branch')
        AND NOT EXISTS (
          SELECT 1 FROM ${ledger} t
          WHERE t."is_deleted" = false
            AND t."order_id" IS NULL
            AND t."dedup_key" IN (
              'cashbox-history:' || k."id",
              'operator-payment:' || k."source_id",
              NULLIF(k."dedup_epoch", '')
            )
        )
    ) x
    GROUP BY x.category`;
  return { sql, params };
}

export type ExpenseReportRawRow = {
  category: string | null;
  /** ⚠️ `numeric` SATR bo'lib keladi (`"12" + "5"` xavfi). */
  total_amount: string | number | null;
  transaction_count: string | number | null;
};

const toTiyin = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const fromTiyin = (value: number) => value / 100;
const percentage = (part: number, total: number) =>
  total !== 0 ? Math.round((part / total) * 10000) / 100 : 0;

/**
 * Xom guruhlar → javob. Summalar butun tiyinda qo'shiladi: kategoriya jamlari
 * yig'indisi `total_amount` ga aniq teng (float qoldig'isiz).
 */
export function aggregateExpenseReport(rows: readonly ExpenseReportRawRow[]) {
  const parsed = rows.map((row) => ({
    category: row.category,
    tiyin: toTiyin(row.total_amount),
    count: Number(row.transaction_count ?? 0),
  }));
  const total = parsed.reduce((acc, row) => acc + row.tiyin, 0);
  const uncategorized = parsed.find((row) => row.category === null);

  return {
    total_amount: fromTiyin(total),
    transaction_count: parsed.reduce((acc, row) => acc + row.count, 0),
    categories: parsed
      .filter((row) => row.category !== null)
      .sort((a, b) => b.tiyin - a.tiyin)
      .map((row) => ({
        category: row.category as string,
        total_amount: fromTiyin(row.tiyin),
        transaction_count: row.count,
        percentage: percentage(row.tiyin, total),
      })),
    uncategorized: {
      total_amount: fromTiyin(uncategorized?.tiyin ?? 0),
      transaction_count: uncategorized?.count ?? 0,
      percentage: percentage(uncategorized?.tiyin ?? 0, total),
    },
  };
}
