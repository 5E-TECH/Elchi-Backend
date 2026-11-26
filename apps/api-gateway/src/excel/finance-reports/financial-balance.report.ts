import type { FinancialSource_type } from '@app/common';
import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  addBanner,
  addDataBars,
  addKpis,
  addMeta,
  addReportSheet,
  addSection,
  addTable,
  createReport,
  formula,
  reportToBuffer,
  toExcelDate,
  type ReportKpi,
} from '@app/report-kit';
import {
  EXPENSE_CATEGORY_LABEL_UZ,
  FINANCIAL_SOURCE_LABEL_UZ,
  UNCATEGORIZED_EXPENSE_LABEL,
  toFinancialBalanceExportRow,
  type FinancialActor,
} from '../../financial-balance/financial-balance.util';
import {
  asText,
  dateText,
  idValue,
  numberOrNull,
  periodText,
  round2,
  sumBy,
  textOrNull,
  timeOf,
  toAmount,
} from './report-labels';
import {
  addCheckNote,
  addDivider,
  addTruncationNote,
  balanceCheck,
  checkFormula,
  formulaIf,
  printTitles,
  textFormula,
  wrapColumn,
} from './report-parts';

/** Moliyaviy balans daftari (B3) — `GET export/financial-balance.xlsx`. */
export interface FinancialBalanceReportInput {
  items: ReadonlyArray<Record<string, unknown>>;
  total: number;
  limit: number;
  filters: {
    source_type?: string;
    expense_category?: string;
    from_date?: string;
    to_date?: string;
  };
  actors: ReadonlyMap<string, FinancialActor | null>;
  now?: Date;
}

/** Daftar va Xulosa yorliqlari (FE `v2Balance.sources`): sotuv / bekor farqlanadi. */
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  ...FINANCIAL_SOURCE_LABEL_UZ,
  ...({
    sell_extra_cost: "Qo'shimcha xarajat (sotuv)",
    cancel_extra_cost: "Qo'shimcha xarajat (bekor)",
    correction: 'Tuzatish',
    pickup_fee: 'Olib ketish haqi',
  } satisfies Partial<Record<`${FinancialSource_type}`, string>>),
};
const AUTO = 'Avtomatik';

const SHEET = 'Daftar';
const HEADER_ROW = 6;
const FIRST_ROW = HEADER_ROW + 1;

interface LedgerRow {
  id: number | string | null;
  order: number;
  createdAt: unknown;
  source: string;
  category: string;
  change: number;
  before: number | null;
  after: number | null;
  comment: string | null;
  who: string;
  orderId: number | string | null;
}

export function buildFinancialBalanceReport(
  input: FinancialBalanceReportInput,
): Promise<Buffer> {
  const now = input.now ?? new Date();
  const f = input.filters;
  const createdAt = (row: Record<string, unknown>) =>
    row.createdAt ?? row.created_at;
  const sorted = [...input.items].sort(
    (a, b) =>
      timeOf(createdAt(a)) - timeOf(createdAt(b)) ||
      toAmount(a.id) - toAmount(b.id),
  );
  const rows = sorted.slice(-input.limit).map((raw): LedgerRow => {
    const mapped = toFinancialBalanceExportRow(raw, input.actors);
    const source = asText(raw.source_type);
    return {
      id: idValue(raw.id),
      order: toAmount(raw.id),
      createdAt: createdAt(raw),
      source: SOURCE_LABEL[source] ?? source,
      category: asText(mapped.category),
      change: round2(toAmount(mapped.change)),
      before: numberOrNull(raw.balance_before),
      after: numberOrNull(raw.balance_after),
      comment: textOrNull(mapped.comment),
      who: asText(mapped.created_by),
      orderId: idValue(raw.order_id),
    };
  });
  const total = Math.max(input.total, sorted.length);
  const truncated = total > rows.length;
  const n = rows.length;
  const R2 = FIRST_ROW + n - 1;
  const range = (c: string) => `${SHEET}!$${c}$${FIRST_ROW}:$${c}$${R2}`;
  const period = periodText(f.from_date, f.to_date);

  const income = sumBy(rows, (row) => Math.max(row.change, 0));
  const expense = sumBy(rows, (row) => Math.max(-row.change, 0));
  const incomeCount = rows.filter((row) => row.change > 0).length;
  const expenseCount = rows.filter((row) => row.change < 0).length;

  // Qoldiq zanjiri — faqat to'liq daftarda (manba / kategoriya filtri yo'q).
  // Birinchi / oxirgi yozuv — `id` bo'yicha (joriy balans ham shunday olinadi).
  const complete = !truncated && !f.source_type && !f.expense_category && n > 0;
  let firstIndex = 0;
  let lastIndex = 0;
  if (complete) {
    rows.forEach((row, i) => {
      if (row.order < rows[firstIndex].order) firstIndex = i;
      if (row.order > rows[lastIndex].order) lastIndex = i;
    });
  }
  const opening = complete ? rows[firstIndex].before : null;
  const closing = complete ? rows[lastIndex].after : null;

  const workbook = createReport('Moliyaviy balans', now);

  // ── 1. Xulosa ──
  const ws = addReportSheet(workbook, 'Xulosa', Array<number>(12).fill(8), {
    footer: 'Moliyaviy balans',
  });
  let r = addBanner(ws, {
    title: 'Moliyaviy balans',
    subtitle: 'Foyda va xarajatlar daftari',
    right: period,
    rightSub: 'Davr',
  });
  r = addMeta(ws, r, [
    {
      label: 'Manba',
      value: f.source_type
        ? (SOURCE_LABEL[f.source_type] ?? f.source_type)
        : 'Barcha manbalar',
    },
    {
      label: 'Kategoriya',
      value: !f.expense_category
        ? 'Barcha kategoriyalar'
        : ((EXPENSE_CATEGORY_LABEL_UZ as Record<string, string>)[
            f.expense_category
          ] ?? UNCATEGORIZED_EXPENSE_LABEL),
    },
    { label: 'Yozuvlar soni', value: n, fmt: F.int },
    { label: 'Tayyorlangan', value: toExcelDate(now), fmt: F.dateTime },
  ]);
  if (truncated) {
    r = addTruncationNote(ws, r, { total, shown: n, noun: 'yozuv' });
  }
  const kpiRow = r;
  const middle: ReportKpi[] = [
    {
      label: "Kirim, so'm",
      value: formulaIf(n > 0, `SUMIF(${range('F')},">0")`, income),
      tone: 'success',
      sub: `${incomeCount} ta yozuv`,
    },
    {
      label: "Chiqim, so'm",
      value: formulaIf(n > 0, `-SUMIF(${range('F')},"<0")`, expense),
      tone: 'danger',
      sub: `${expenseCount} ta yozuv`,
    },
  ];
  const openingRef = `${SHEET}!G${FIRST_ROW + firstIndex}`;
  const closingRef = `${SHEET}!H${FIRST_ROW + lastIndex}`;
  r = addKpis(
    ws,
    r,
    opening !== null && closing !== null
      ? [
          {
            label: "Davr boshida, so'm",
            value: formula(openingRef, opening),
            sub: dateText(rows[firstIndex].createdAt),
          },
          ...middle,
          {
            label: "Davr oxirida, so'm",
            value: formula(closingRef, closing),
            tone: 'action',
            sub: dateText(rows[lastIndex].createdAt),
          },
        ]
      : [
          { label: 'Yozuvlar', value: n, fmt: F.int },
          ...middle,
          {
            label: "Kirim − chiqim, so'm",
            value: formulaIf(n > 0, `SUM(${range('F')})`, income - expense),
            fmt: F.signed,
            tone: 'action',
          },
        ],
  );
  if (n > 0) {
    ws.getCell(kpiRow + 2, 5).value = textFormula(
      `COUNTIF(${range('F')},">0")&" ta yozuv"`,
      `${incomeCount} ta yozuv`,
    );
    ws.getCell(kpiRow + 2, 8).value = textFormula(
      `COUNTIF(${range('F')},"<0")&" ta yozuv"`,
      `${expenseCount} ta yozuv`,
    );
  }
  if (opening !== null && closing !== null) {
    const okText = 'Mos keldi: davr boshi + kirim − chiqim = davr oxiri';
    const check = balanceCheck(opening + income - expense, closing, okText);
    r = addCheckNote(
      ws,
      r,
      checkFormula(
        `${openingRef}+SUM(${range('F')})`,
        closingRef,
        okText,
        check,
      ),
      check,
    );
  }

  r = addSection(ws, r, "Manba bo'yicha");
  const bySource = new Map<
    string,
    { label: string; count: number; income: number; expense: number }
  >();
  const byCategory = new Map<
    string,
    { label: string; count: number; sum: number }
  >();
  for (const row of rows) {
    const item = bySource.get(row.source) ?? {
      label: row.source,
      count: 0,
      income: 0,
      expense: 0,
    };
    item.count += 1;
    if (row.change > 0) item.income = round2(item.income + row.change);
    else item.expense = round2(item.expense - row.change);
    bySource.set(row.source, item);
    if (row.change < 0 && row.category) {
      const category = byCategory.get(row.category) ?? {
        label: row.category,
        count: 0,
        sum: 0,
      };
      category.count += 1;
      category.sum = round2(category.sum - row.change);
      byCategory.set(row.category, category);
    }
  }
  const sourceTable = addTable(ws, r, {
    total: true,
    empty: "Yozuv yo'q",
    rows: [...bySource.values()].sort(
      (a, b) => b.income + b.expense - (a.income + a.expense),
    ),
    columns: [
      { header: 'Manba', span: 4, value: (x) => x.label },
      {
        header: 'Soni',
        align: 'center',
        fmt: F.int,
        sum: true,
        value: (x, k) => formula(`COUNTIFS(${range('D')},B${k})`, x.count),
      },
      {
        header: "Kirim, so'm",
        span: 2,
        fmt: F.somDash,
        sum: true,
        tone: (x) => (x.income ? 'success' : 'neutral'),
        value: (x, k) =>
          formula(
            `SUMIFS(${range('F')},${range('D')},B${k},${range('F')},">0")`,
            x.income,
          ),
      },
      {
        header: "Chiqim, so'm",
        span: 2,
        fmt: F.somDash,
        sum: true,
        tone: (x) => (x.expense ? 'danger' : 'neutral'),
        value: (x, k) =>
          formula(
            `-SUMIFS(${range('F')},${range('D')},B${k},${range('F')},"<0")`,
            x.expense,
          ),
      },
      {
        header: "Sof, so'm",
        span: 3,
        fmt: F.signed,
        bold: true,
        sum: true,
        value: (x, k) => formula(`G${k}-I${k}`, round2(x.income - x.expense)),
      },
    ],
  });
  r = sourceTable.next;

  const categories = [...byCategory.values()].sort((a, b) => b.sum - a.sum);
  if (categories.length) {
    r = addSection(ws, r, 'Xarajat kategoriyalari', 'Tuzatishlar kirmaydi');
    const first = r + 1;
    const last = r + categories.length;
    const spent = sumBy(categories, (x) => x.sum);
    const categoryTable = addTable(ws, r, {
      total: true,
      rows: categories,
      columns: [
        { header: 'Kategoriya', span: 4, value: (x) => x.label },
        {
          header: 'Soni',
          align: 'center',
          fmt: F.int,
          sum: true,
          value: (x, k) =>
            formula(
              `COUNTIFS(${range('E')},B${k},${range('F')},"<0")`,
              x.count,
            ),
        },
        {
          header: "Summa, so'm",
          span: 3,
          fmt: F.som,
          bold: true,
          sum: true,
          value: (x, k) =>
            formula(
              `-SUMIFS(${range('F')},${range('E')},B${k},${range('F')},"<0")`,
              x.sum,
            ),
        },
        {
          header: 'Ulush',
          span: 4,
          fmt: F.pct,
          align: 'right',
          value: (x, k) =>
            formula(
              `IF(G$${last + 1}=0,0,G${k}/G$${last + 1})`,
              spent ? x.sum / spent : 0,
            ),
          totalValue: formula(`SUM(J${first}:J${last})`, spent ? 1 : 0),
        },
      ],
    });
    addDataBars(ws, `J${categoryTable.first}:J${categoryTable.last}`, C.action);
  }

  // ── 2. Daftar ──
  const list = addReportSheet(
    workbook,
    SHEET,
    [10, 16, 27, 18, 15, 16, 16, 36, 19, 13],
    {
      orientation: 'landscape',
      freeze: HEADER_ROW,
      tab: C.action,
      footer: 'Moliyaviy balans',
    },
  );
  const head = addBanner(list, {
    title: 'Moliyaviy daftar',
    subtitle: period,
    right: truncated ? `${n} / ${total} ta yozuv` : `${n} ta yozuv`,
    rightSub: 'Eskidan yangiga',
  });
  const table = addTable(list, head, {
    total: true,
    filter: true,
    empty: "Yozuv yo'q",
    rows,
    columns: [
      { header: 'ID', align: 'center', fmt: '0', value: (x) => x.id },
      {
        header: 'Sana',
        fmt: F.dateTime,
        value: (x) => toExcelDate(x.createdAt),
      },
      { header: 'Manba', value: (x) => x.source },
      {
        header: 'Kategoriya',
        tone: (x) =>
          x.category === UNCATEGORIZED_EXPENSE_LABEL ? 'warning' : undefined,
        value: (x) => x.category || null,
      },
      {
        header: "O'zgarish, so'm",
        fmt: F.signed,
        bold: true,
        sum: true,
        tone: (x) => (x.change >= 0 ? 'success' : 'danger'),
        value: (x) => x.change,
      },
      { header: "Oldingi balans, so'm", fmt: F.som, value: (x) => x.before },
      { header: "Keyingi balans, so'm", fmt: F.som, value: (x) => x.after },
      { header: 'Izoh', value: (x) => x.comment },
      {
        header: 'Kim kiritgan',
        tone: (x) => (x.who === AUTO ? 'neutral' : undefined),
        value: (x) => x.who,
      },
      {
        header: 'Buyurtma ID',
        align: 'center',
        fmt: '0',
        value: (x) => x.orderId,
      },
    ],
  });
  if (n > 0) {
    wrapColumn(list, table, 7);
    for (const c of [5, 8]) addDivider(list, table, c);
  }
  printTitles(list, table.header);
  return reportToBuffer(workbook);
}
