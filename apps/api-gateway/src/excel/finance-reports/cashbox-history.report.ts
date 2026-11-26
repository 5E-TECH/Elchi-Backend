import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  addBanner,
  addKpis,
  addMeta,
  addReportSheet,
  addSection,
  addTable,
  createReport,
  formula,
  reportFont,
  reportToBuffer,
  toExcelDate,
  type ReportKpi,
} from '@app/report-kit';
import type { Worksheet } from 'exceljs';
import {
  balanceChain,
  correctionStatus,
  routeText,
  cashboxName,
  historyLabel,
  isCashMethod,
  sortHistory,
  toHistoryRow,
  type BalanceChain,
  type HistoryRow,
} from './cashbox-history';
import {
  CASH_LABEL,
  cashboxSourceLabel,
  cashboxTypeLabel,
  dateText,
  operationLabel,
  paymentMethodLabel,
  periodText,
  round2,
  sameMoney,
  sumBy,
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

/** Kassa tarixi (B1) — `GET export/cashbox-history.xlsx`. */
export interface CashboxHistoryFilters {
  cashbox_id?: string;
  operation_type?: string;
  source_type?: string;
  sourceTypes?: string;
  source_user_id?: string;
  user_id?: string;
  cashbox_type?: string;
  from_date?: string;
  to_date?: string;
}

export interface CashboxHistoryReportInput {
  items: ReadonlyArray<Record<string, unknown>>;
  /** Bazadagi jami qator (fayl chegarasidan ko'p bo'lishi mumkin). */
  total: number;
  limit: number;
  filters: CashboxHistoryFilters;
  branchNames: ReadonlyMap<string, string>;
  now?: Date;
}

const HEADER_ROW = 6;
const FIRST_ROW = HEADER_ROW + 1;
const SHEET = 'Harakatlar';

/** Amal / manba filtri matni. */
const filterText = (f: CashboxHistoryFilters): string => {
  const parts: string[] = [];
  if (f.operation_type) parts.push(operationLabel(f.operation_type));
  const sources = (f.sourceTypes ?? f.source_type ?? '')
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source) => cashboxSourceLabel(source));
  if (sources.length) parts.push(sources.join(', '));
  if (f.source_user_id) parts.push(`Manba #${f.source_user_id}`);
  return parts.join(' · ') || 'Barcha amal va manbalar';
};

/** Faqat davr filtri va BITTA kassa — qoldiq zanjiri uzilmagan. */
const isSingleCashbox = (
  f: CashboxHistoryFilters,
  rows: readonly HistoryRow[],
): boolean =>
  !f.operation_type &&
  !f.source_type &&
  !f.sourceTypes &&
  !f.source_user_id &&
  Boolean(f.cashbox_id || f.user_id || f.cashbox_type === 'main') &&
  rows.length > 0 &&
  rows.every((row) => row.cashboxId && row.cashboxId === rows[0].cashboxId);

export function buildCashboxHistoryReport(
  input: CashboxHistoryReportInput,
): Promise<Buffer> {
  const now = input.now ?? new Date();
  const f = input.filters;
  const sorted = sortHistory(input.items.map(toHistoryRow));
  const rows = sorted.slice(-input.limit);
  const total = Math.max(input.total, sorted.length);
  const truncated = total > rows.length;
  const n = rows.length;
  const R2 = FIRST_ROW + n - 1;
  const ref = (c: string, r: number) => `${SHEET}!${c}${r}`;
  const range = (c: string) => `${SHEET}!$${c}$${FIRST_ROW}:$${c}$${R2}`;

  const sameCashbox = new Set(rows.map((row) => row.cashboxId)).size === 1;
  const single = !truncated && isSingleCashbox(f, rows);
  const chain = single ? balanceChain(rows) : null;

  const income = sumBy(rows, (row) => (row.income ? row.amount : 0));
  const expense = sumBy(rows, (row) => (row.income ? 0 : row.amount));
  const incomeCount = rows.filter((row) => row.income).length;
  const period = periodText(f.from_date, f.to_date);
  const name = sameCashbox
    ? cashboxName(rows[0], input.branchNames)
    : f.cashbox_type
      ? cashboxTypeLabel(f.cashbox_type)
      : f.cashbox_id
        ? `Kassa #${f.cashbox_id}`
        : 'Barcha kassalar';

  const workbook = createReport('Kassa tarixi', now);

  // ── 1. Xulosa ──
  const ws = addReportSheet(workbook, 'Xulosa', Array<number>(12).fill(8), {
    footer: 'Kassa tarixi',
  });
  let r = addBanner(ws, {
    title: 'Kassa tarixi',
    subtitle: name,
    right: period,
    rightSub: 'Davr',
  });
  r = addMeta(ws, r, [
    {
      label: 'Kassa',
      value: sameCashbox ? `${name} · #${rows[0].cashboxId}` : name,
    },
    { label: 'Filtr', value: filterText(f) },
    { label: 'Harakatlar soni', value: n, fmt: F.int },
    { label: 'Tayyorlangan', value: toExcelDate(now), fmt: F.dateTime },
  ]);
  if (truncated) {
    r = addTruncationNote(ws, r, { total, shown: n, noun: 'harakat' });
  }
  const middle: ReportKpi[] = [
    {
      label: "Kirim, so'm",
      value: formulaIf(n > 0, `SUM(${range('H')})`, income),
      tone: 'success',
      sub: `${incomeCount} ta harakat`,
    },
    {
      label: "Chiqim, so'm",
      value: formulaIf(n > 0, `SUM(${range('I')})`, expense),
      tone: 'danger',
      sub: `${n - incomeCount} ta harakat`,
    },
  ];
  const kpiRow = r;
  r = addKpis(
    ws,
    r,
    chain
      ? [
          {
            label: "Boshlang'ich qoldiq, so'm",
            value: openingFormula(chain),
            sub: dateText(rows[chain.firstIndex].createdAt),
          },
          ...middle,
          {
            label: "Oxirgi qoldiq, so'm",
            value: formula(
              ref('J', FIRST_ROW + chain.lastIndex),
              chain.closing,
            ),
            tone: 'action',
            sub: dateText(rows[chain.lastIndex].createdAt),
          },
        ]
      : [
          { label: 'Harakatlar', value: n, fmt: F.int },
          ...middle,
          {
            label: "Kirim − chiqim, so'm",
            value: formulaIf(
              n > 0,
              `SUM(${range('H')})-SUM(${range('I')})`,
              income - expense,
            ),
            fmt: F.signed,
            tone: 'action',
          },
        ],
  );
  if (n > 0) {
    // Sonlar formulada — ro'yxat tahrirlansa ham to'g'ri qolsin.
    const start = [5, 8];
    (['H', 'I'] as const).forEach((c, i) => {
      ws.getCell(kpiRow + 2, start[i]).value = textFormula(
        `COUNT(${range(c)})&" ta harakat"`,
        `${c === 'H' ? incomeCount : n - incomeCount} ta harakat`,
      );
    });
  }
  if (chain) {
    r = addBalanceBlock(ws, r, {
      rows,
      chain,
      income,
      expense,
      range,
      ref,
    });
  }

  r = addSection(ws, r, "Manba bo'yicha");
  const bySource = new Map<
    string,
    { label: string; count: number; income: number; expense: number }
  >();
  for (const row of rows) {
    const label = historyLabel(row);
    const item = bySource.get(label) ?? {
      label,
      count: 0,
      income: 0,
      expense: 0,
    };
    item.count += 1;
    if (row.income) item.income = round2(item.income + row.amount);
    else item.expense = round2(item.expense + row.amount);
    bySource.set(label, item);
  }
  const sources = [...bySource.values()].sort(
    (a, b) => b.income + b.expense - (a.income + a.expense),
  );
  addTable(ws, r, {
    total: true,
    empty: "Harakat yo'q",
    rows: sources,
    columns: [
      { header: 'Manba', span: 4, value: (x) => x.label },
      {
        header: 'Soni',
        align: 'center',
        fmt: F.int,
        sum: true,
        value: (x, k) => formula(`COUNTIFS(${range('F')},B${k})`, x.count),
      },
      {
        header: "Kirim, so'm",
        span: 2,
        fmt: F.somDash,
        sum: true,
        tone: (x) => (x.income ? 'success' : 'neutral'),
        value: (x, k) =>
          formula(`SUMIFS(${range('H')},${range('F')},B${k})`, x.income),
      },
      {
        header: "Chiqim, so'm",
        span: 2,
        fmt: F.somDash,
        sum: true,
        tone: (x) => (x.expense ? 'danger' : 'neutral'),
        value: (x, k) =>
          formula(`SUMIFS(${range('I')},${range('F')},B${k})`, x.expense),
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

  // ── 2. Harakatlar ──
  const list = addReportSheet(
    workbook,
    SHEET,
    // (2026-11-26) oxirida «Yo'nalish» va «Holat» — oldingi ustun harflari
    // (formulalar: H, I, J …) o'zgarmaydi.
    [5, 16, sameCashbox ? 18 : 26, 10, 27, 18, 14, 14, 14, 14, 14, 36, 40, 20],
    {
      orientation: 'landscape',
      freeze: HEADER_ROW,
      tab: C.action,
      footer: 'Kassa tarixi',
    },
  );
  const head = addBanner(list, {
    title: 'Kassa harakatlari',
    subtitle: `${name} · ${period}`,
    right: truncated ? `${n} / ${total} ta harakat` : `${n} ta harakat`,
    rightSub: 'Eskidan yangiga',
  });
  const table = addTable(list, head, {
    total: true,
    filter: true,
    empty: "Harakat yo'q",
    rows,
    columns: [
      { header: '№', align: 'center', value: (_row, k) => k - FIRST_ROW + 1 },
      {
        header: 'Sana',
        fmt: F.dateTime,
        value: (row) => toExcelDate(row.date),
      },
      {
        header: 'Kassa',
        value: (row) => {
          const label = cashboxName(row, input.branchNames);
          return sameCashbox ? label : `${label} · #${row.cashboxId}`;
        },
      },
      {
        header: 'Amal turi',
        badge: true,
        tone: (row) => (row.income ? 'success' : 'danger'),
        value: (row) => operationLabel(row.income ? 'income' : 'expense'),
      },
      { header: 'Manba', value: historyLabel },
      {
        header: "To'lov usuli",
        value: (row) => paymentMethodLabel(row.method),
      },
      {
        header: "Kirim, so'm",
        fmt: F.som,
        color: C.success,
        sum: true,
        value: (row) => (row.income ? row.amount : null),
      },
      {
        header: "Chiqim, so'm",
        fmt: F.som,
        color: C.danger,
        sum: true,
        value: (row) => (row.income ? null : row.amount),
      },
      {
        header: "Balans, so'm",
        fmt: F.som,
        bold: true,
        value: (row) => row.balance,
      },
      {
        header: "Naqd balans, so'm",
        fmt: F.som,
        value: (row) => row.balanceCash,
      },
      {
        header: "Karta balans, so'm",
        fmt: F.som,
        value: (row) => row.balanceCard,
      },
      { header: 'Izoh', value: (row) => row.comment ?? row.category },
      // (2026-11-26, ega) kimdan → kimga: kuryer, filial, asosiy kassa, market.
      {
        header: "Yo'nalish (kimdan → kimga)",
        value: (row) => routeText(row, input.branchNames),
      },
      // T6: qaytarilgan / tahrirlangan to'lov va uning teskari qatori.
      { header: 'Holat', value: correctionStatus },
    ],
  });
  if (n > 0) {
    wrapColumn(list, table, 11);
    wrapColumn(list, table, 12);
    addDivider(list, table, 9);
  }
  printTitles(list, table.header);
  return reportToBuffer(workbook);
}

const openingFormula = (chain: BalanceChain) => {
  const k = FIRST_ROW + chain.firstIndex;
  return formula(
    `${SHEET}!J${k}-N(${SHEET}!H${k})+N(${SHEET}!I${k})`,
    chain.opening,
  );
};

/** «Qoldiq harakati» + nazorat (faqat bitta kassa, faqat davr filtri). */
function addBalanceBlock(
  ws: Worksheet,
  row: number,
  o: {
    rows: readonly HistoryRow[];
    chain: BalanceChain;
    income: number;
    expense: number;
    range: (column: string) => string;
    ref: (column: string, row: number) => string;
  },
): number {
  const { chain, rows, range, ref, income, expense } = o;
  const kf = FIRST_ROW + chain.firstIndex;
  const kl = FIRST_ROW + chain.lastIndex;
  const okText =
    "Mos keldi: boshlang'ich qoldiq + kirim − chiqim = oxirgi qoldiq";
  const check = balanceCheck(
    chain.opening + income - expense,
    chain.closing,
    okText,
  );
  const r = addSection(ws, row, 'Qoldiq harakati');
  const q = r + 1;
  // Naqd / karta ajratmasi FAQAT asosiy kassada yuritiladi (kuryer / market —
  // qarz hisobi, filial — bitta jami: 1bz6tOle, 63HO6cBU).
  const split = rows[0].cashboxType === 'main' && check.ok ? chain.split : null;

  if (!split) {
    const table = addTable(ws, r, {
      zebra: false,
      total: true,
      totalLabel: 'Oxirgi qoldiq',
      rows: [
        {
          t: "Boshlang'ich qoldiq",
          v: openingFormula(chain),
        },
        { t: 'Kirim', v: formula(`SUM(${range('H')})`, income) },
        { t: 'Chiqim', v: formula(`SUM(${range('I')})`, expense) },
      ],
      columns: [
        { header: "Ko'rsatkich", span: 9, value: (x) => x.t },
        {
          header: "Jami, so'm",
          span: 3,
          fmt: F.som,
          bold: true,
          value: (x) => x.v,
          totalValue: formula(
            `K${q}+K${q + 1}-K${q + 2}`,
            round2(chain.opening + income - expense),
          ),
        },
      ],
    });
    toneRows(ws, q, ['K'], 'K');
    return addCheckNote(
      ws,
      table.next - 1,
      checkFormula(`K${table.totalRow}`, ref('J', kl), okText, check),
      check,
    );
  }

  const cashIn = sumBy(rows, (x) =>
    x.income && isCashMethod(x) ? x.amount : 0,
  );
  const cashOut = sumBy(rows, (x) =>
    !x.income && isCashMethod(x) ? x.amount : 0,
  );
  const cardIn = round2(income - cashIn);
  const cardOut = round2(expense - cashOut);
  // Naqd ↔ karta o'tkazmasi kassa tarixida qator EMAS (jami o'zgarmaydi) —
  // ajratmadagi farq alohida qatorda ko'rsatiladi.
  const moved = round2(
    split.closingCash - (split.openingCash + cashIn - cashOut),
  );
  const hasMove = !sameMoney(moved, 0);
  const m = q + 3;
  const line = (
    t: string,
    a: ReturnType<typeof formula>,
    b: ReturnType<typeof formula>,
    k: number,
    sum: number,
  ) => ({ t, a, b, c: formula(`E${k}+H${k}`, round2(sum)) });
  const totalOf = (c: string, value: number) =>
    formula(
      `${c}${q}+${c}${q + 1}-${c}${q + 2}${hasMove ? `+${c}${m}` : ''}`,
      round2(value),
    );
  const cashOnly = (c: string) =>
    `SUMIFS(${range(c)},${range('G')},"${CASH_LABEL}")`;
  const table = addTable(ws, r, {
    zebra: false,
    total: true,
    totalLabel: 'Oxirgi qoldiq',
    rows: [
      line(
        "Boshlang'ich qoldiq",
        formula(
          `${ref('K', kf)}-IF(${ref('G', kf)}="${CASH_LABEL}",N(${ref('H', kf)})-N(${ref('I', kf)}),0)`,
          split.openingCash,
        ),
        formula(
          `${ref('L', kf)}-IF(${ref('G', kf)}<>"${CASH_LABEL}",N(${ref('H', kf)})-N(${ref('I', kf)}),0)`,
          split.openingCard,
        ),
        q,
        split.openingCash + split.openingCard,
      ),
      line(
        'Kirim',
        formula(cashOnly('H'), cashIn),
        formula(`SUM(${range('H')})-E${q + 1}`, cardIn),
        q + 1,
        income,
      ),
      line(
        'Chiqim',
        formula(cashOnly('I'), cashOut),
        formula(`SUM(${range('I')})-E${q + 2}`, cardOut),
        q + 2,
        expense,
      ),
      ...(hasMove
        ? [
            line(
              "Naqd ↔ karta o'tkazmasi",
              formula(`${ref('K', kl)}-(E${q}+E${q + 1}-E${q + 2})`, moved),
              formula(`${ref('L', kl)}-(H${q}+H${q + 1}-H${q + 2})`, -moved),
              m,
              0,
            ),
          ]
        : []),
    ],
    columns: [
      { header: "Ko'rsatkich", span: 3, value: (x) => x.t },
      {
        header: "Naqd, so'm",
        span: 3,
        fmt: F.som,
        value: (x) => x.a,
        totalValue: totalOf('E', split.closingCash),
      },
      {
        header: "Karta, so'm",
        span: 3,
        fmt: F.som,
        value: (x) => x.b,
        totalValue: totalOf('H', split.closingCard),
      },
      {
        header: "Jami, so'm",
        span: 3,
        fmt: F.som,
        bold: true,
        value: (x) => x.c,
        totalValue: totalOf('K', chain.closing),
      },
    ],
  });
  toneRows(ws, q, ['E', 'H', 'K'], 'K');
  if (hasMove) {
    for (const c of ['E', 'H', 'K']) ws.getCell(`${c}${m}`).numFmt = F.signed;
  }
  return addCheckNote(
    ws,
    table.next - 1,
    checkFormula(`K${table.totalRow}`, ref('J', kl), okText, check),
    check,
  );
}

/** Kirim — yashil, chiqim — qizil (q — boshlang'ich qoldiq qatori). */
function toneRows(
  ws: Worksheet,
  q: number,
  columns: readonly string[],
  boldColumn: string,
): void {
  for (const c of columns) {
    ws.getCell(`${c}${q + 1}`).font = reportFont({
      bold: c === boldColumn,
      color: C.success,
    });
    ws.getCell(`${c}${q + 2}`).font = reportFont({
      bold: c === boldColumn,
      color: C.danger,
    });
  }
}
