import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  addNote,
  addReportSheet,
  addSection,
  addTable,
  createReport,
  formula,
  reportFont,
  reportToBuffer,
  toExcelDate,
  type ReportTableResult,
} from '@app/report-kit';
import type { CellValue, Worksheet } from 'exceljs';
import {
  balanceChain,
  correctionStatus,
  historyLabel,
  routeText,
  isCashMethod,
  sortHistory,
  toHistoryRow,
  type HistoryRow,
} from './cashbox-history';
import {
  MAIN_CASHBOX_NAME,
  branchLabel,
  dateTimeText,
  moneyText,
  orderNumberOf,
  round2,
  sameMoney,
  sumBy,
} from './report-labels';
import {
  addBannerSplit,
  addCheckNote,
  addDivider,
  addKpisAt,
  addSignaturesAt,
  addTruncationNote,
  balanceCheck,
  checkFormula,
  wrapColumn,
  type PlacedKpi,
} from './report-parts';

/**
 * Kassa hisoboti — `GET export/cashbox-report.xlsx`: asosiy kassa (B5) va
 * filial kassasi (B6, bitta jami — naqd/karta qoldig'i yo'q, 63HO6cBU).
 */
export interface CashboxBalances {
  total: number;
  /** Naqd / karta ajratmasi — `null`: yuritilmaydi yoki eski yozuvda yo'q. */
  cash: number | null;
  card: number | null;
}

export interface CashboxReportInput {
  kind: 'main' | 'branch';
  /** Filial nomi (B6); noma'lum — «Filial kassasi». */
  branchName?: string | null;
  items: ReadonlyArray<Record<string, unknown>>;
  total: number;
  limit: number;
  /** Kassaning HOZIRGI qoldig'i. */
  balances: CashboxBalances;
  /** Davr hozirgacha — hozirgi qoldiq bilan solishtirish mumkin. */
  untilNow: boolean;
  /**
   * Davrda amal bo'lmaganda davrdan oldingi oxirgi qoldiq (o'tgan davr).
   * `null` — olinmadi.
   */
  previous?: CashboxBalances | null;
  period: string;
  /** Smena bo'yicha: «Smena №16 · 08:02 — 20:14». */
  shiftLabel?: string | null;
  branchNames: ReadonlyMap<string, string>;
  /**
   * (2026-11-26, ega) Faqat asosiy kassa: davrda menejerlar FILIAL kassasi
   * orqali marketlarga bergan pul (filial kassasidan to'lov va kuryerning
   * «Marketga o'tkazma»si) — `include_route` bilan. Asosiy kassa balansiga
   * kirmaydi, alohida bo'lim. Yo'q / olinmadi — bo'lim chizilmaydi.
   */
  branchMarketItems?: ReadonlyArray<Record<string, unknown>> | null;
  now?: Date;
}

interface OpRow {
  n: number;
  who: string;
  cash: number | null;
  card: number | null;
  other: number | null;
  amount: number;
  comment: string;
  by: string;
}

/** Naqd / karta / boshqa (marketga to'g'ridan-to'g'ri) — FE hisoboti bilan bir xil. */
const bucketOf = (row: HistoryRow): 'cash' | 'card' | 'other' =>
  isCashMethod(row) ? 'cash' : row.method === 'click' ? 'card' : 'other';

/** Qarshi tomon: kuryer / market / filial nomi, bo'lmasa manba yorlig'i. */
const counterparty = (
  row: HistoryRow,
  kind: 'main' | 'branch',
  branchNames: ReadonlyMap<string, string>,
): string => {
  if (row.sourceUserName) return row.sourceUserName;
  if (kind === 'main' && row.source === 'branch_to_main') {
    // `source_user_id` bu turda — FILIAL id si.
    const branch = branchNames.get(row.sourceUserId);
    if (branch) return branch;
  }
  return historyLabel(row);
};

const toOps = (
  rows: readonly HistoryRow[],
  kind: 'main' | 'branch',
  branchNames: ReadonlyMap<string, string>,
): OpRow[] =>
  rows.map((row, i) => {
    const bucket = bucketOf(row);
    return {
      n: i + 1,
      who: counterparty(row, kind, branchNames),
      cash: bucket === 'cash' ? row.amount : null,
      card: bucket === 'card' ? row.amount : null,
      other: bucket === 'other' ? row.amount : null,
      amount: row.amount,
      // (2026-11-26) T6: «Qaytarilgan» / «Qaytarish (#asl)» izohga qo'shiladi.
      comment: [
        row.comment ??
          row.category ??
          orderNumberOf(row.source, row.sourceId) ??
          historyLabel(row),
        correctionStatus(row),
      ]
        .filter(Boolean)
        .join(' · '),
      by: row.createdByName ?? (row.createdBy ? `#${row.createdBy}` : '—'),
    };
  });

interface OpTotals {
  cash: number;
  card: number;
  other: number;
  amount: number;
  count: number;
}
const totalsOf = (rows: readonly OpRow[]): OpTotals => ({
  cash: sumBy(rows, (row) => row.cash),
  card: sumBy(rows, (row) => row.card),
  other: sumBy(rows, (row) => row.other),
  amount: sumBy(rows, (row) => row.amount),
  count: rows.length,
});

function addOpTable(
  ws: Worksheet,
  row: number,
  o: {
    rows: readonly OpRow[];
    totals: OpTotals;
    who: string;
    totalLabel: string;
    tone: 'success' | 'danger';
  },
): ReportTableResult {
  const color = o.tone === 'success' ? C.success : C.danger;
  const first = row + 1;
  const last = row + o.rows.length;
  const table = addTable(ws, row, {
    total: true,
    totalLabel: '',
    empty: "Operatsiya yo'q",
    rows: o.rows,
    columns: [
      { header: '№', align: 'center', value: (x) => x.n },
      { header: o.who, value: (x) => x.who, totalValue: o.totalLabel },
      { header: "Naqd, so'm", fmt: F.som, sum: true, value: (x) => x.cash },
      { header: "Karta, so'm", fmt: F.som, sum: true, value: (x) => x.card },
      { header: "Boshqa, so'm", fmt: F.som, sum: true, value: (x) => x.other },
      {
        header: "Jami, so'm",
        fmt: F.som,
        bold: true,
        color,
        value: (x, k) => formula(`SUM(D${k}:F${k})`, x.amount),
        totalValue: formula(`SUM(G${first}:G${last})`, o.totals.amount),
      },
      { header: 'Izoh', value: (x) => x.comment },
      { header: 'Kiritgan', value: (x) => x.by },
    ],
  });
  if (o.rows.length) {
    wrapColumn(ws, table, 1);
    wrapColumn(ws, table, 6);
    for (const c of [3, 7]) addDivider(ws, table, c);
  }
  if (table.totalRow) {
    for (const c of ['D', 'E', 'F', 'G']) {
      ws.getCell(`${c}${table.totalRow}`).font = reportFont({
        bold: true,
        color,
      });
    }
  }
  return table;
}

/** Jadval jami katagiga havola (bo'sh jadval — 0). */
const totalRef = (
  table: ReportTableResult,
  column: string,
  value: number,
): CellValue =>
  table.totalRow ? formula(`${column}${table.totalRow}`, value) : 0;

export function buildCashboxReport(input: CashboxReportInput): Promise<Buffer> {
  const now = input.now ?? new Date();
  const isMain = input.kind === 'main';
  const sorted = sortHistory(input.items.map(toHistoryRow));
  const rows = sorted.slice(-input.limit);
  const total = Math.max(input.total, sorted.length);
  const truncated = total > rows.length;
  const incomeRows = toOps(
    rows.filter((row) => row.income),
    input.kind,
    input.branchNames,
  );
  const expenseRows = toOps(
    rows.filter((row) => !row.income),
    input.kind,
    input.branchNames,
  );
  const inc = totalsOf(incomeRows);
  const exp = totalsOf(expenseRows);

  // ── Qoldiqlar ──
  const chain = truncated ? null : balanceChain(rows);
  /** Davr oxiri: hozirgacha — hozirgi qoldiq, o'tgan davr — oxirgi amaldan keyin. */
  const closing: CashboxBalances | null = input.untilNow
    ? input.balances
    : chain
      ? {
          total: chain.closing,
          cash: chain.split?.closingCash ?? null,
          card: chain.split?.closingCard ?? null,
        }
      : rows.length
        ? null
        : (input.previous ?? null);
  const opening: CashboxBalances | null = truncated
    ? null
    : chain
      ? {
          total: chain.opening,
          cash: chain.split?.openingCash ?? null,
          card: chain.split?.openingCard ?? null,
        }
      : rows.length
        ? null
        : closing;

  const cashboxTitle = isMain
    ? MAIN_CASHBOX_NAME
    : input.branchName
      ? `${input.branchName} kassasi`
      : 'Filial kassasi';
  const footer = isMain ? 'Asosiy kassa hisoboti' : cashboxTitle;
  const workbook = createReport(footer, now);
  const ws = addReportSheet(
    workbook,
    isMain ? MAIN_CASHBOX_NAME : 'Filial kassasi',
    isMain ? [5, 27, 13, 13, 13, 14, 31, 19] : [5, 27, 13, 13, 13, 13, 26, 19],
    { footer },
  );
  let r = addBannerSplit(
    ws,
    {
      title: cashboxTitle,
      subtitle: input.shiftLabel ?? 'Kirim, chiqim va kassa balansi',
      right: input.period,
      rightSub: isMain ? 'Kassa hisoboti' : 'Filial kassasi hisoboti',
    },
    7,
  );
  if (truncated) {
    r = addTruncationNote(ws, r, {
      total,
      shown: rows.length,
      noun: 'operatsiya',
    });
  }

  // ── Kartalar ── (jami formulalari jadvallar qurilgach qo'yiladi)
  const kpiRow = r;
  const valueRow = kpiRow + 1;
  const opsSub = (count: number) => `${count} ta operatsiya`;
  const incomeKpi = {
    label: "Jami kirim, so'm",
    value: inc.amount,
    tone: 'success',
    sub: opsSub(inc.count),
  } as const;
  const expenseKpi = {
    label: "Jami chiqim, so'm",
    value: exp.amount,
    tone: 'danger',
    sub: opsSub(exp.count),
  } as const;
  const balanceLabel = input.untilNow
    ? "Kassa balansi, so'm"
    : "Davr oxirida, so'm";
  const kpis: PlacedKpi[] = isMain
    ? [
        {
          from: 2,
          to: 3,
          label: balanceLabel,
          value: closing?.total ?? '—',
          tone: 'action',
          sub: input.untilNow ? 'Naqd + karta' : 'Oxirgi operatsiyadan keyin',
        },
        {
          from: 4,
          to: 5,
          label: "Naqd qoldiq, so'm",
          value: closing?.cash ?? '—',
          sub: input.untilNow ? 'Kassada' : 'Davr oxirida',
        },
        {
          from: 6,
          to: 7,
          label: "Karta qoldiq, so'm",
          value: closing?.card ?? '—',
          sub: input.untilNow ? 'Kartalarda' : 'Davr oxirida',
        },
        { from: 8, to: 8, ...incomeKpi },
        { from: 9, to: 9, ...expenseKpi },
      ]
    : [
        {
          from: 2,
          to: 3,
          label: balanceLabel,
          value: closing?.total ?? '—',
          tone: 'action',
          sub: input.untilNow ? 'Davr oxirida' : 'Oxirgi operatsiyadan keyin',
        },
        {
          from: 4,
          to: 5,
          label: "Davr boshida, so'm",
          value: opening?.total ?? '—',
          sub: 'Birinchi operatsiyagacha',
        },
        { from: 6, to: 7, ...incomeKpi },
        { from: 8, to: 8, ...expenseKpi },
        {
          from: 9,
          to: 9,
          label: "Kirim − chiqim, so'm",
          value: formula(
            `F${valueRow}-H${valueRow}`,
            round2(inc.amount - exp.amount),
          ),
          fmt: F.signed,
          sub: "Davrda o'zgardi",
        },
      ];
  r = addKpisAt(ws, r, kpis);

  // ── Nazorat ──
  const computed =
    opening === null ? null : round2(opening.total + inc.amount - exp.amount);
  const known = opening !== null && closing !== null && computed !== null;
  let movement:
    ((ti: ReportTableResult, te: ReportTableResult) => void) | null = null;
  if (isMain) {
    if (known) {
      const block = addMovement(ws, r, {
        opening,
        closing,
        inc,
        exp,
        untilNow: input.untilNow,
        balanceCell: `B${valueRow}`,
      });
      r = block.next;
      movement = block.link;
    }
  } else if (known) {
    const okText = 'Mos keldi: davr boshi + kirim − chiqim = kassa balansi';
    const check = balanceCheck(computed, closing.total, okText);
    // O'tgan davr — hozirgi balans bilan solishtirilmaydi; farq bo'lsa aytiladi.
    if (input.untilNow || !check.ok) {
      r = addCheckNote(
        ws,
        r,
        checkFormula(
          `D${valueRow}+F${valueRow}-H${valueRow}`,
          `B${valueRow}`,
          okText,
          check,
        ),
        check,
      );
    }
  }

  r = addSection(ws, r, 'Kirim', opsSub(inc.count));
  const ti = addOpTable(ws, r, {
    rows: incomeRows,
    totals: inc,
    who: 'Qayerdan',
    totalLabel: 'Jami kirim',
    tone: 'success',
  });
  r = addSection(ws, ti.next, 'Chiqim / Xarajat', opsSub(exp.count));
  const te = addOpTable(ws, r, {
    rows: expenseRows,
    totals: exp,
    who: 'Qayerga',
    totalLabel: 'Jami chiqim',
    tone: 'danger',
  });
  r = te.next;
  if (isMain && input.branchMarketItems?.length) {
    r = addBranchMarketSection(
      ws,
      r,
      input.branchMarketItems,
      input.branchNames,
    );
  }

  ws.getCell(valueRow, isMain ? 8 : 6).value = totalRef(ti, 'G', inc.amount);
  ws.getCell(valueRow, isMain ? 9 : 8).value = totalRef(te, 'G', exp.amount);
  if (isMain && input.untilNow) {
    const { total: balance, cash, card } = input.balances;
    if (cash !== null && card !== null && sameMoney(cash + card, balance)) {
      ws.getCell(valueRow, 2).value = formula(
        `D${valueRow}+F${valueRow}`,
        balance,
      );
    }
  }
  movement?.(ti, te);

  if (isMain && (inc.other || exp.other)) {
    r = addNote(
      ws,
      r,
      "«Boshqa» — pul to'g'ridan-to'g'ri market hisobiga o'tgan: kirim va chiqimga birdek yoziladi, qoldiq o'zgarmaydi.",
      'info',
    );
  }
  if (!input.untilNow) {
    const { total: balance, cash, card } = input.balances;
    const parts =
      cash !== null && card !== null
        ? ` — naqd ${moneyText(cash)}, karta ${moneyText(card)}`
        : '';
    r = addNote(
      ws,
      r,
      `Hozirgi kassa balansi (${dateTimeText(now)} holatiga): ${moneyText(balance)} so'm${parts}.`,
      'info',
    );
  }
  addSignaturesAt(ws, r, [
    { from: 2, to: 3, label: isMain ? 'Topshirdi' : 'Filial menejeri' },
    { from: 5, to: 6, label: 'Qabul qildi' },
    { from: 8, to: 8, label: 'Sana' },
  ]);
  return reportToBuffer(workbook);
}

/** Filial orqali marketga to'lov turi (yo'nalish noma'lum — usuldan). */
const branchMarketKind = (row: HistoryRow): string => {
  const variant = row.route?.variant;
  if (variant === 'courier_click_branch' || row.method === 'click_to_market') {
    const courier = row.route?.courier;
    return courier
      ? `Kuryer ${courier.name ?? `#${courier.id}`} o'tkazmasi`
      : "Kuryer o'tkazmasi";
  }
  return "Filial kassasidan to'lov";
};

/**
 * (2026-11-26, ega) «Filiallar orqali marketlarga» — davrda menejerlar filial
 * kassasi orqali marketlarga bergan pul (asosiy kassa balansiga kirmaydi):
 * sana, yo'nalish (filial → market), turi, summa, holat (qaytarilgan), kim
 * yozgan. Eskidan yangiga.
 */
function addBranchMarketSection(
  ws: Worksheet,
  row: number,
  items: ReadonlyArray<Record<string, unknown>>,
  branchNames: ReadonlyMap<string, string>,
): number {
  const rows = sortHistory(items.map(toHistoryRow));
  const r = addSection(
    ws,
    row,
    'Filiallar orqali marketlarga',
    `${rows.length} ta to'lov`,
  );
  const first = r + 1;
  const last = r + rows.length;
  const table = addTable(ws, r, {
    total: true,
    totalLabel: '',
    empty: "To'lov yo'q",
    rows,
    columns: [
      { header: '№', align: 'center', value: (_x, k) => k - first + 1 },
      {
        header: 'Sana',
        fmt: F.dateTime,
        value: (x) => toExcelDate(x.date),
        totalValue: "Jami (ma'lumot uchun)",
      },
      {
        header: "Yo'nalish (filial → market)",
        span: 3,
        value: (x) =>
          routeText(x, branchNames) ??
          `${branchLabel(x.cashboxOwnerId, branchNames)} kassasi → ${x.sourceUserName ?? 'market'}`,
      },
      {
        header: "Summa, so'm",
        fmt: F.som,
        bold: true,
        value: (x) => x.amount,
        // Jadval B dan: №=B, Sana=C, Yo'nalish=D:F, Summa=G.
        totalValue: formula(
          `SUM(G${first}:G${last})`,
          sumBy(rows, (x) => x.amount),
        ),
      },
      {
        header: 'Turi · holat',
        value: (x) =>
          [branchMarketKind(x), correctionStatus(x)]
            .filter(Boolean)
            .join(' · '),
      },
      {
        header: 'Kiritgan',
        value: (x) =>
          x.createdByName ?? (x.createdBy ? `#${x.createdBy}` : '—'),
      },
    ],
  });
  if (rows.length) {
    wrapColumn(ws, table, 2);
    wrapColumn(ws, table, 4);
  }
  return addNote(
    ws,
    table.next,
    "Bu bo'lim asosiy kassa balansiga kirmaydi: pul filial kassasidan yoki kuryerdan to'g'ridan-to'g'ri marketga o'tgan. Qaytarilgan to'lov ham ro'yxatda qoladi («Qaytarilgan»).",
    'info',
  );
}

/** «Kassa harakati» — davr boshi, kirim, chiqim, davr oxiri (asosiy kassa). */
function addMovement(
  ws: Worksheet,
  row: number,
  o: {
    opening: CashboxBalances;
    closing: CashboxBalances;
    inc: OpTotals;
    exp: OpTotals;
    untilNow: boolean;
    balanceCell: string;
  },
): {
  next: number;
  link: (ti: ReportTableResult, te: ReportTableResult) => void;
} {
  const { opening, closing, inc, exp } = o;
  const split =
    opening.cash !== null &&
    opening.card !== null &&
    closing.cash !== null &&
    closing.card !== null
      ? {
          openCash: opening.cash,
          openCard: opening.card,
          closeCash: closing.cash,
        }
      : null;
  const r = addSection(ws, row, 'Kassa harakati');
  const q = r + 1;
  const otherNet = round2(inc.other - exp.other);
  const closingTotal = round2(opening.total + inc.amount - exp.amount);
  const okText = o.untilNow
    ? 'Kassa balansiga teng'
    : 'Oxirgi operatsiyadan keyingi qoldiq';
  const check = balanceCheck(closingTotal, closing.total, okText);
  // Naqd ↔ karta o'tkazmasi tarixda qator EMAS (jami o'zgarmaydi).
  const moved =
    split && check.ok
      ? round2(split.closeCash - (split.openCash + inc.cash - exp.cash))
      : 0;
  const hasMove = !sameMoney(moved, 0);
  const extra = hasMove ? 1 : 0;
  const totalRow = q + 3 + extra;
  const net = (c: string) =>
    `${c}${q}+${c}${q + 1}-${c}${q + 2}${hasMove ? `+${c}${q + 3}` : ''}`;
  interface Line {
    t: string;
    a: CellValue;
    b: CellValue;
    o: CellValue;
    j: CellValue;
    note: string;
  }
  const lines: Line[] = [
    {
      t: 'Davr boshida',
      a: opening.cash,
      b: opening.card,
      o: null,
      j: split ? formula(`SUM(D${q}:F${q})`, opening.total) : opening.total,
      note: "Birinchi operatsiyagacha bo'lgan qoldiq",
    },
    {
      t: 'Kirim',
      a: inc.cash,
      b: inc.card,
      o: inc.other,
      j: inc.amount,
      note: `${inc.count} ta operatsiya`,
    },
    {
      t: 'Chiqim',
      a: exp.cash,
      b: exp.card,
      o: exp.other,
      j: exp.amount,
      note: `${exp.count} ta operatsiya`,
    },
    ...(hasMove
      ? [
          {
            t: "Naqd ↔ karta o'tkazmasi",
            a: moved,
            b: -moved,
            o: null,
            j: formula(`SUM(D${q + 3}:F${q + 3})`, 0),
            note: "Kassa ichida, jami o'zgarmaydi",
          },
        ]
      : []),
  ];
  const splitTotal = (c: string, value: number) =>
    split ? formula(net(c), round2(value)) : null;
  const table = addTable(ws, r, {
    zebra: false,
    total: true,
    totalLabel: 'Davr oxirida (balans)',
    rows: lines,
    columns: [
      { header: "Ko'rsatkich", span: 2, value: (x) => x.t },
      {
        header: "Naqd, so'm",
        fmt: F.som,
        value: (x) => x.a,
        totalValue: splitTotal(
          'D',
          (split?.openCash ?? 0) + inc.cash - exp.cash + moved,
        ),
      },
      {
        header: "Karta, so'm",
        fmt: F.som,
        value: (x) => x.b,
        totalValue: splitTotal(
          'E',
          (split?.openCard ?? 0) + inc.card - exp.card - moved,
        ),
      },
      {
        header: "Boshqa, so'm",
        fmt: F.somDash,
        value: (x) => x.o,
        totalValue: formula(`F${q + 1}-F${q + 2}`, otherNet),
      },
      {
        header: "Jami, so'm",
        fmt: F.som,
        bold: true,
        value: (x) => x.j,
        totalValue: formula(net('G'), closingTotal),
      },
      { header: 'Izoh', span: 2, value: (x) => x.note },
    ],
  });
  const paint = (n: number, color: string) => {
    for (const c of ['D', 'E', 'F', 'G']) {
      ws.getCell(`${c}${n}`).font = reportFont({ bold: c === 'G', color });
    }
  };
  paint(q + 1, C.success);
  paint(q + 2, C.danger);
  for (let n = q; n < totalRow; n += 1) {
    ws.getCell(`H${n}`).font = reportFont({ size: 9, color: C.muted });
  }
  if (hasMove) {
    for (const c of ['D', 'E', 'G'])
      ws.getCell(`${c}${q + 3}`).numFmt = F.signed;
  }
  const note = ws.getCell(`H${totalRow}`);
  note.value =
    o.untilNow || !check.ok
      ? checkFormula(`G${totalRow}`, o.balanceCell, okText, check)
      : okText;
  note.font = reportFont({
    size: 9,
    bold: true,
    color: !check.ok ? C.warning : o.untilNow ? C.success : C.muted,
  });
  return {
    next: table.next,
    link: (ti, te) => {
      const set = (rowNumber: number, t: ReportTableResult, sums: OpTotals) => {
        ws.getCell(`D${rowNumber}`).value = totalRef(t, 'D', sums.cash);
        ws.getCell(`E${rowNumber}`).value = totalRef(t, 'E', sums.card);
        ws.getCell(`F${rowNumber}`).value = totalRef(t, 'F', sums.other);
        ws.getCell(`G${rowNumber}`).value = totalRef(t, 'G', sums.amount);
      };
      set(q + 1, ti, inc);
      set(q + 2, te, exp);
    },
  };
}
