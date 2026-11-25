import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  addBanner,
  addKpis,
  addMeta,
  addNote,
  addReportSheet,
  addSection,
  addTable,
  createReport,
  formula,
  reportFont,
  reportToBuffer,
  toExcelDate,
  type ReportColumn,
  type ReportTone,
} from '@app/report-kit';
import {
  MAIN_CASHBOX_NAME,
  asText,
  branchLabel,
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
  addDivider,
  addGroupHeader,
  addTruncationNote,
  formulaIf,
  printTitles,
  textFormula,
  wrapColumn,
} from './report-parts';

/** Smenalar (B2) — `GET export/shifts.xlsx`. */
export interface ShiftsReportInput {
  items: ReadonlyArray<Record<string, unknown>>;
  total: number;
  limit: number;
  filters: {
    status?: string;
    opened_by?: string;
    from_date?: string;
    to_date?: string;
  };
  branchNames: ReadonlyMap<string, string>;
  now?: Date;
}

const SHEET = 'Smenalar';
const HEADER_ROW = 7;
const FIRST_ROW = HEADER_ROW + 1;
const NOT_COUNTED = 'Sanalmadi';
const SYSTEM = 'Tizim';
/** Xulosadagi farqli smenalar — eng so'nggi shuncha (qolgani ro'yxatda). */
const ATTENTION_LIMIT = 200;

interface ShiftSide {
  opening: number | null;
  income: number | null;
  expense: number | null;
  /** `Sanalmadi` — sanalgan summa kiritilmagan. */
  closing: number | typeof NOT_COUNTED | null;
  /** `null` — farq yo'q (ochiq / sanalmagan / filialda karta yuritilmaydi). */
  diff: number | null;
}

interface ShiftRow {
  id: number | string | null;
  cashbox: string;
  openedAt: Date | null;
  openedBy: string;
  closedAt: Date | null;
  closedBy: string | null;
  open: boolean;
  cash: ShiftSide;
  card: ShiftSide;
  comment: string | null;
}

const sideOf = (
  raw: Record<string, unknown>,
  kind: 'cash' | 'card',
  open: boolean,
  isBranch: boolean,
): ShiftSide => {
  const opening = numberOrNull(raw[`opening_balance_${kind}`]);
  const income = numberOrNull(raw[`total_income_${kind}`]);
  const expense = numberOrNull(raw[`total_expense_${kind}`]);
  const closing = numberOrNull(raw[`closing_balance_${kind}`]);
  const diff = open ? null : numberOrNull(raw[`discrepancy_${kind}`]);
  // Filial smenasi bitta jami (63HO6cBU): karta ustunlari yo'q — «Sanalmadi»
  // ham emas. Eski (ajratilgan) smenada qiymat bo'lsa — ko'rinadi.
  if (isBranch && kind === 'card' && diff === null) {
    const blank = (value: number | null) => value || null;
    return {
      opening: blank(opening),
      income: blank(income),
      expense: blank(expense),
      closing: open ? null : blank(closing),
      diff: null,
    };
  }
  return {
    opening,
    // Ochiq smenada yig'indi hali yozilmagan (0) — soxta «0 kirim» emas.
    income: open ? income || null : income,
    expense: open ? expense || null : expense,
    closing: open ? null : diff === null && !closing ? NOT_COUNTED : closing,
    diff,
  };
};

const toShiftRow = (
  raw: Record<string, unknown>,
  branchNames: ReadonlyMap<string, string>,
): ShiftRow => {
  const open = raw.status !== 'closed';
  const owner = asText(raw.cashbox_user_id).trim();
  const isBranch = owner !== '' && owner !== '0';
  const person = (name: unknown, id: unknown, system: unknown): string =>
    textOrNull(name) ??
    (system === true ? SYSTEM : textOrNull(id) ? `#${asText(id)}` : '—');
  return {
    id: idValue(raw.id),
    cashbox: isBranch ? branchLabel(owner, branchNames) : MAIN_CASHBOX_NAME,
    openedAt: toExcelDate(raw.opened_at),
    openedBy: person(raw.opened_by_name, raw.opened_by, raw.opened_by_system),
    closedAt: toExcelDate(raw.closed_at),
    closedBy: open
      ? null
      : person(raw.closed_by_name, raw.closed_by, raw.closed_by_system),
    open,
    cash: sideOf(raw, 'cash', open, isBranch),
    card: sideOf(raw, 'card', open, isBranch),
    comment: textOrNull(raw.comment),
  };
};

const diffTone = (diff: number | null): ReportTone =>
  diff === null
    ? 'warning'
    : diff < 0
      ? 'danger'
      : diff > 0
        ? 'warning'
        : 'neutral';

const negative = (value: number | null) =>
  value !== null && value < 0 ? value : 0;
const positive = (value: number | null) =>
  value !== null && value > 0 ? value : 0;

export function buildShiftsReport(input: ShiftsReportInput): Promise<Buffer> {
  const now = input.now ?? new Date();
  const f = input.filters;
  const sorted = [...input.items].sort(
    (a, b) =>
      timeOf(a.opened_at) - timeOf(b.opened_at) ||
      toAmount(a.id) - toAmount(b.id),
  );
  const shown = sorted.slice(-input.limit);
  const rows = shown.map((raw) => toShiftRow(raw, input.branchNames));
  const total = Math.max(input.total, sorted.length);
  const truncated = total > rows.length;
  const n = rows.length;
  const R2 = FIRST_ROW + n - 1;
  const range = (c: string) => `${SHEET}!$${c}$${FIRST_ROW}:$${c}$${R2}`;
  const period = periodText(f.from_date, f.to_date);
  const closedCount = rows.filter((row) => !row.open).length;
  const shortCount = rows.reduce(
    (count, row) =>
      count +
      (negative(row.cash.diff) ? 1 : 0) +
      (negative(row.card.diff) ? 1 : 0),
    0,
  );
  const totals = {
    cashIn: sumBy(rows, (row) => row.cash.income),
    cardIn: sumBy(rows, (row) => row.card.income),
    cashOut: sumBy(rows, (row) => row.cash.expense),
    cardOut: sumBy(rows, (row) => row.card.expense),
    cashShort: sumBy(rows, (row) => negative(row.cash.diff)),
    cardShort: sumBy(rows, (row) => negative(row.card.diff)),
    cashOver: sumBy(rows, (row) => positive(row.cash.diff)),
    cardOver: sumBy(rows, (row) => positive(row.card.diff)),
  };
  // «Smenalar» ustunlari: B ID | C Kassa | D Ochilgan | E Ochgan | F Yopilgan |
  // G Yopgan | H Holat | I–M naqd | N–R karta | S Izoh.
  const col = {
    status: 'H',
    cashIn: 'J',
    cashOut: 'K',
    cashDiff: 'M',
    cardIn: 'O',
    cardOut: 'P',
    cardDiff: 'R',
  } as const;

  const workbook = createReport('Smenalar', now);

  // ── 1. Xulosa ──
  const ws = addReportSheet(workbook, 'Xulosa', Array<number>(12).fill(8), {
    footer: 'Smenalar',
  });
  const openedName = f.opened_by
    ? (rows.find((row) => row.openedBy !== '—')?.openedBy ?? `#${f.opened_by}`)
    : null;
  let r = addBanner(ws, {
    title: 'Smenalar',
    subtitle: openedName ? `Ochgan: ${openedName}` : 'Barcha xodimlar',
    right: period,
    rightSub: 'Ochilgan vaqti',
  });
  r = addMeta(ws, r, [
    {
      label: 'Holat',
      value:
        f.status === 'open'
          ? 'Ochiq'
          : f.status === 'closed'
            ? 'Yopilgan'
            : 'Ochiq va yopilgan',
    },
    { label: 'Tayyorlangan', value: toExcelDate(now), fmt: F.dateTime },
  ]);
  if (truncated) {
    r = addTruncationNote(ws, r, { total, shown: n, noun: 'smena' });
  }
  const kpiRow = r;
  r = addKpis(ws, r, [
    {
      label: 'Smenalar',
      value: formulaIf(n > 0, `COUNTA(${range('B')})`, n),
      fmt: F.int,
      sub: `${closedCount} yopilgan · ${n - closedCount} ochiq`,
    },
    {
      label: "Kirim, so'm",
      value: formulaIf(
        n > 0,
        `SUM(${range(col.cashIn)},${range(col.cardIn)})`,
        totals.cashIn + totals.cardIn,
      ),
      tone: 'success',
      sub: 'Naqd va karta',
    },
    {
      label: "Chiqim, so'm",
      value: formulaIf(
        n > 0,
        `SUM(${range(col.cashOut)},${range(col.cardOut)})`,
        totals.cashOut + totals.cardOut,
      ),
      tone: 'danger',
      sub: 'Naqd va karta',
    },
    {
      label: "Kamomad, so'm",
      value: formulaIf(
        n > 0,
        `SUMIF(${range(col.cashDiff)},"<0")+SUMIF(${range(col.cardDiff)},"<0")`,
        totals.cashShort + totals.cardShort,
      ),
      tone: 'danger',
      sub: `${shortCount} ta holat`,
    },
  ]);
  if (n > 0) {
    ws.getCell(kpiRow + 2, 2).value = textFormula(
      `COUNTIF(${range(col.status)},"Yopilgan")&" yopilgan · "&COUNTIF(${range(col.status)},"Ochiq")&" ochiq"`,
      `${closedCount} yopilgan · ${n - closedCount} ochiq`,
    );
    ws.getCell(kpiRow + 2, 11).value = textFormula(
      `COUNTIF(${range(col.cashDiff)},"<0")+COUNTIF(${range(col.cardDiff)},"<0")&" ta holat"`,
      `${shortCount} ta holat`,
    );
  }

  r = addSection(ws, r, "Naqd va karta bo'yicha");
  const q = r + 1;
  const pair = (
    label: string,
    cash: string,
    card: string,
    a: number,
    b: number,
    k: number,
  ) => ({
    label,
    a: formulaIf(n > 0, cash, a),
    b: formulaIf(n > 0, card, b),
    c: formula(`E${k}+H${k}`, round2(a + b)),
  });
  const netOf = (c: string, value: number) =>
    formula(`${c}${q}-${c}${q + 1}`, round2(value));
  const summary = addTable(ws, r, {
    zebra: false,
    rows: [
      pair(
        'Kirim',
        `SUM(${range(col.cashIn)})`,
        `SUM(${range(col.cardIn)})`,
        totals.cashIn,
        totals.cardIn,
        q,
      ),
      pair(
        'Chiqim',
        `SUM(${range(col.cashOut)})`,
        `SUM(${range(col.cardOut)})`,
        totals.cashOut,
        totals.cardOut,
        q + 1,
      ),
      {
        label: 'Kirim − chiqim',
        a: netOf('E', totals.cashIn - totals.cashOut),
        b: netOf('H', totals.cardIn - totals.cardOut),
        c: netOf(
          'K',
          totals.cashIn + totals.cardIn - totals.cashOut - totals.cardOut,
        ),
      },
      pair(
        'Kamomad',
        `SUMIF(${range(col.cashDiff)},"<0")`,
        `SUMIF(${range(col.cardDiff)},"<0")`,
        totals.cashShort,
        totals.cardShort,
        q + 3,
      ),
      pair(
        'Ortiqcha',
        `SUMIF(${range(col.cashDiff)},">0")`,
        `SUMIF(${range(col.cardDiff)},">0")`,
        totals.cashOver,
        totals.cardOver,
        q + 4,
      ),
    ],
    columns: [
      { header: "Ko'rsatkich", span: 3, value: (x) => x.label },
      { header: "Naqd, so'm", span: 3, fmt: F.som, value: (x) => x.a },
      { header: "Karta, so'm", span: 3, fmt: F.som, value: (x) => x.b },
      {
        header: "Jami, so'm",
        span: 3,
        fmt: F.som,
        bold: true,
        value: (x) => x.c,
      },
    ],
  });
  const look: ReadonlyArray<readonly [string, string]> = [
    [C.success, F.som],
    [C.danger, F.som],
    [C.navy, F.signed],
    [C.danger, F.somDash],
    [C.warning, F.somDash],
  ];
  look.forEach(([color, fmt], i) => {
    for (const c of ['E', 'H', 'K']) {
      const cell = ws.getCell(`${c}${q + i}`);
      cell.font = reportFont({ bold: c === 'K' || i === 2, color });
      cell.numFmt = fmt;
    }
  });
  ws.getCell(`B${q + 2}`).font = reportFont({ bold: true });
  r = summary.next;

  // Farqli yoki sanalmagan (yopilgan) smenalar.
  const attention = rows.filter(
    (row) =>
      !row.open &&
      (row.cash.diff ||
        row.card.diff ||
        row.cash.closing === NOT_COUNTED ||
        row.card.closing === NOT_COUNTED),
  );
  const listed = attention.slice(-ATTENTION_LIMIT);
  r = addSection(
    ws,
    r,
    'Farqli va sanalmagan smenalar',
    `${attention.length} ta smena`,
  );
  const diffCell = (side: ShiftSide) =>
    side.diff ?? (side.closing === NOT_COUNTED ? NOT_COUNTED : '—');
  const attentionTable = addTable(ws, r, {
    empty: "Farqli smena yo'q",
    rows: listed,
    columns: [
      { header: 'Smena', align: 'center', fmt: '"#"0', value: (x) => x.id },
      { header: 'Kassa', span: 2, value: (x) => x.cashbox },
      {
        header: 'Yopilgan',
        span: 2,
        fmt: F.dateTime,
        value: (x) => x.closedAt,
      },
      {
        header: "Naqd farq, so'm",
        span: 2,
        fmt: F.signed,
        align: 'right',
        bold: true,
        tone: (x) =>
          diffCell(x.cash) === '—' ? 'neutral' : diffTone(x.cash.diff),
        value: (x) => diffCell(x.cash),
      },
      {
        header: "Karta farq, so'm",
        span: 2,
        fmt: F.signed,
        align: 'right',
        bold: true,
        tone: (x) =>
          diffCell(x.card) === '—' ? 'neutral' : diffTone(x.card.diff),
        value: (x) => diffCell(x.card),
      },
      { header: 'Izoh', span: 3, value: (x) => x.comment },
    ],
  });
  if (listed.length) wrapColumn(ws, attentionTable, 5);
  r = attentionTable.next;
  if (listed.length < attention.length) {
    r = addNote(
      ws,
      r,
      `Eng so'nggi ${listed.length} tasi ko'rsatildi, qolgan ${attention.length - listed.length} tasi — «${SHEET}» varag'ida.`,
      'warning',
    );
  }
  if (rows.some((row) => row.cashbox !== MAIN_CASHBOX_NAME)) {
    addNote(
      ws,
      r,
      'Filial smenasi bitta jami bilan yuritiladi — summalari naqd ustunlarida.',
      'info',
    );
  }

  // ── 2. Smenalar ──
  const list = addReportSheet(
    workbook,
    SHEET,
    [8, 18, 16, 18, 16, 18, 11, 13, 13, 13, 13, 12, 13, 13, 13, 13, 12, 34],
    {
      orientation: 'landscape',
      freeze: HEADER_ROW,
      tab: C.action,
      footer: 'Smenalar',
    },
  );
  const groupRow = addBanner(list, {
    title: "Smenalar ro'yxati",
    subtitle: period,
    right: truncated ? `${n} / ${total} ta smena` : `${n} ta smena`,
    rightSub: 'Farq = yopilish − kutilgan qoldiq',
  });
  const head = addGroupHeader(list, groupRow, [
    { from: 9, to: 13, label: "NAQD, SO'M" },
    { from: 14, to: 18, label: "KARTA, SO'M" },
  ]);
  const sideColumns = (
    pick: (row: ShiftRow) => ShiftSide,
    diffLetter: string,
    diffTotal: number,
  ): Array<ReportColumn<ShiftRow>> => [
    { header: 'Ochilish', fmt: F.som, value: (x) => pick(x).opening },
    {
      header: 'Kirim',
      fmt: F.som,
      color: C.success,
      sum: true,
      value: (x) => pick(x).income,
    },
    {
      header: 'Chiqim',
      fmt: F.som,
      color: C.danger,
      sum: true,
      value: (x) => pick(x).expense,
    },
    {
      header: 'Yopilish',
      fmt: F.som,
      align: 'right',
      bold: true,
      tone: (x) => (pick(x).closing === NOT_COUNTED ? 'warning' : undefined),
      value: (x) => pick(x).closing,
    },
    {
      header: 'Farq',
      fmt: F.signed,
      align: 'right',
      bold: true,
      tone: (x) => diffTone(pick(x).diff),
      value: (x) => pick(x).diff,
      totalValue: formulaIf(
        n > 0,
        `SUM(${diffLetter}${FIRST_ROW}:${diffLetter}${R2})`,
        diffTotal,
      ),
    },
  ];
  const table = addTable(list, head, {
    total: true,
    filter: true,
    empty: "Smena yo'q",
    rows,
    columns: [
      { header: 'ID', align: 'center', fmt: '"#"0', value: (x) => x.id },
      { header: 'Kassa', value: (x) => x.cashbox },
      { header: 'Ochilgan', fmt: F.dateTime, value: (x) => x.openedAt },
      { header: 'Ochgan', value: (x) => x.openedBy },
      { header: 'Yopilgan', fmt: F.dateTime, value: (x) => x.closedAt },
      { header: 'Yopgan', value: (x) => x.closedBy },
      {
        header: 'Holat',
        badge: true,
        tone: (x) => (x.open ? 'info' : 'neutral'),
        value: (x) => (x.open ? 'Ochiq' : 'Yopilgan'),
      },
      ...sideColumns(
        (x) => x.cash,
        col.cashDiff,
        totals.cashShort + totals.cashOver,
      ),
      ...sideColumns(
        (x) => x.card,
        col.cardDiff,
        totals.cardShort + totals.cardOver,
      ),
      { header: 'Izoh', value: (x) => x.comment },
    ],
  });
  if (n > 0) {
    wrapColumn(list, table, 17);
    for (const c of [8, 13, 18]) addDivider(list, table, c);
  }
  printTitles(list, table.header - 1, table.header);
  return reportToBuffer(workbook);
}
