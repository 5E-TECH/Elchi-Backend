import type { CellValue, Workbook, Worksheet } from 'exceljs';
import {
  REPORT_COLORS,
  REPORT_TONES,
  addNote,
  addReportSheet,
  addSection,
  addSignatures,
  addTable,
  columnLetter,
  createReport,
  formula,
  lastColumn,
  reportFont,
  reportToBuffer,
  toExcelDate,
  type ReportBanner,
  type ReportColumn,
  type ReportTableResult,
  type ReportTone,
} from '@app/report-kit';
import {
  autoClosedLabel,
  tashkentClock,
  tashkentDateTime,
} from '../shift-auto-close/shift-schedule.rules';
import {
  AI_STATUS_LABELS,
  type BranchSlice,
  type CourierSlice,
  type MarketSlice,
  type ShiftMoneyBlock,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import {
  SHIFT_FMT as F,
  addGroupedPayments,
  addKpisAt,
  addMetaAt,
  addSectionAt,
  addShareBars,
  addShiftBanner,
  addSignaturesAt,
  addStatement,
  addTotalsAt,
  isCashLine,
  methodTitle,
  moneyFmt,
  sumOf,
  type GroupedColumn,
  type GroupedLine,
  type PaymentGroup,
  type Span,
  type TotalsRow,
} from './shift-report.xlsx-blocks';

/**
 * Smena Excel'lari (ega tasdiqlagan dizayn, 2026-11-25):
 *  - A1 / A1b `buildXlsx` (asosiy kassa) — Xulosa, Filiallar, Kuryerlar,
 *    Marketlar, Kartalar;
 *  - A2 `buildXlsx` (filial kassasi, bitta jami — 63HO6cBU) — Xulosa,
 *    Kuryerlar, Marketlar;
 *  - A3 `buildBranchSliceXlsx` — FAQAT shu filial HQ'ga topshirgan pul;
 *  - A4 `buildMarketXlsx` — FAQAT shu market to'lovlari.
 * A3 / A4 ga smenaning boshqa raqamlari (kassa, kuryer, boshqa filial / market)
 * UMUMAN berilmaydi — faqat `slice`.
 */

const C = REPORT_COLORS;

type ClosedShift = Pick<
  ShiftReportSnapshot,
  'shift_id' | 'closed_at' | 'close_reason'
>;

// ───────────────────────── matnlar ─────────────────────────

const day = (at: Date | string | null) =>
  at ? tashkentDateTime(at).slice(0, 10) : '—';
const clock = (at: Date | string | null) => (at ? tashkentClock(at) : '—');

/** «24.11.2026 · 08:57–21:34» yoki ikki kunli davr. */
const periodText = (
  s: Pick<ShiftReportSnapshot, 'opened_at' | 'closed_at'>,
): string =>
  day(s.opened_at) === day(s.closed_at)
    ? `${day(s.opened_at)} · ${clock(s.opened_at)}–${clock(s.closed_at)}`
    : `${day(s.opened_at)} ${clock(s.opened_at)} – ${day(s.closed_at)} ${clock(s.closed_at)}`;

const dateCell = (at: Date | string | null): CellValue =>
  toExcelDate(at) ?? '—';

const openedText = (s: ShiftReportSnapshot): string =>
  s.opened_by_system
    ? 'Tizim (avtomatik)'
    : (s.opened_by_name ?? (s.opened_by ? `#${s.opened_by}` : '—'));

const closedText = (s: ShiftReportSnapshot, short = false): string => {
  if (s.close_reason === 'auto') {
    return short
      ? 'Avtomatik'
      : `Avtomatik — ${clock(s.closed_at)}, kassir yopmagan`;
  }
  return `Qo'lda — ${s.closed_by_name ?? (s.closed_by ? `#${s.closed_by}` : '—')}`;
};

const handedText = (s: ShiftReportSnapshot): string =>
  s.close_reason !== 'auto' && s.closed_by_name
    ? `Topshirdi: ${s.closed_by_name}`
    : 'Topshirdi';

const closeTag = (
  s: ClosedShift,
): Pick<ReportBanner, 'right' | 'rightSub'> => ({
  right: `Smena #${s.shift_id}`,
  rightSub:
    s.close_reason === 'auto' ? 'Avtomatik yopilgan' : "Qo'lda yopilgan",
});

/** Filial yorlig'i: «Andijon filiali»; nom olinmagan — `fallback`. */
const branchTitle = (
  name: string | null | undefined,
  fallback: string,
): string => {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return fallback;
  return /filial/i.test(clean) ? clean : `${clean} filiali`;
};

const diffWord = (value: number | null): string =>
  value == null
    ? 'Sanalmadi'
    : value < 0
      ? 'Kamomad'
      : value > 0
        ? 'Ortiqcha'
        : 'Mos';

const diffTone = (value: number | null): ReportTone =>
  value == null
    ? 'warning'
    : value < 0
      ? 'danger'
      : value > 0
        ? 'warning'
        : 'success';

const diffSub = (value: number, matched: string): string =>
  value ? `${diffWord(value)} bor` : matched;

const aiTitle = (status: string): string => {
  const label = AI_STATUS_LABELS[status] ?? status;
  return label ? label[0].toUpperCase() + label.slice(1) : label;
};

const AI_TONES: Record<string, ReportTone> = {
  match: 'success',
  mismatch: 'danger',
  unreadable: 'warning',
  error: 'warning',
  pending: 'info',
  disabled: 'neutral',
  not_required: 'neutral',
};

// ───────────────────────── hisob (faqat ko'rsatish) ─────────────────────────

const money = (value: number): number => Math.round(value * 100) / 100;

/** Kassa bloki — bo'sh (eski smena) maydonlar 0 / tizim hisobi bilan. */
interface Block {
  opening: number;
  income: number;
  expense: number;
  expected: number;
  closing: number;
  diff: number | null;
  /** Kutilgan − (ochilish + kirim − chiqim): naqd ↔ karta o'tkazma. */
  conversion: number;
}

const blockOf = (b: ShiftMoneyBlock): Block => {
  const opening = b.opening_balance ?? 0;
  const income = b.total_income ?? 0;
  const expense = b.total_expense ?? 0;
  const system = money(opening + income - expense);
  const expected = b.expected_balance ?? system;
  return {
    opening,
    income,
    expense,
    expected,
    closing: b.closing_balance ?? 0,
    diff: b.discrepancy,
    conversion: money(expected - system),
  };
};

interface SliceTotals {
  count: number;
  cash: number;
  card: number;
  gross: number;
  /** Qaytarilgan — musbat son. */
  reversed: number;
  net: number;
}

/** To'lovlar: yalpi naqd / karta, qaytarilgan, sof, soni (qaytarish qatorisiz). */
const sliceTotals = (slice: {
  payments: ReadonlyArray<{
    amount: number;
    payment_method: string;
    reversed?: boolean;
  }>;
  total: number;
}): SliceTotals => {
  const paid = slice.payments.filter((line) => !line.reversed);
  const back = slice.payments.filter((line) => line.reversed);
  const gross = sumOf(paid, (line) => line.amount);
  const cash = sumOf(paid.filter(isCashLine), (line) => line.amount);
  return {
    count: paid.length,
    cash,
    card: money(gross - cash),
    gross,
    reversed: sumOf(back, (line) => -line.amount),
    net: slice.total,
  };
};

const courierReceived = (slice: CourierSlice): number =>
  slice.received ?? slice.total + (slice.reversed ?? 0);

interface FlowRow {
  name: string;
  sum: number;
}

/** Kirim / chiqim taqsimoti: smena jami − ma'lum manbalar = «Boshqa». */
function moneyFlows(s: ShiftReportSnapshot): {
  income: FlowRow[];
  incomeTotal: number;
  expense: FlowRow[];
  expenseTotal: number;
} {
  const isMain = s.cashbox_type === 'main';
  const cash = blockOf(s.cash);
  const card = blockOf(s.card);
  const incomeTotal = money(cash.income + card.income);
  const expenseTotal = money(cash.expense + card.expense);
  const branches = (isMain ? (s.branches ?? []) : []).map(sliceTotals);
  const markets = s.markets.map(sliceTotals);
  // Filial kassasi: HQ'ga topshirilgan (yalpi) — chiqim, qaytgani — kirim.
  const hq = isMain ? null : (s.hq_transfers ?? null);
  const income: FlowRow[] = [
    ...(isMain
      ? [
          {
            name: 'Filiallardan qabul',
            sum: sumOf(branches, (row) => row.gross),
          },
        ]
      : []),
    { name: 'Kuryerlardan qabul', sum: sumOf(s.couriers, courierReceived) },
    { name: 'Marketdan qaytgan', sum: sumOf(markets, (row) => row.reversed) },
    ...(hq?.reversed
      ? [{ name: "HQ'dan qaytgan (bekor qilingan)", sum: hq.reversed }]
      : []),
  ];
  const expense: FlowRow[] = [
    { name: "Marketlarga to'lov", sum: sumOf(markets, (row) => row.gross) },
    ...(hq && (hq.count || hq.reversed)
      ? [
          {
            name: `HQ'ga topshirilgan (${hq.count} ta)`,
            sum: money(hq.total + hq.reversed),
          },
        ]
      : []),
    ...(isMain
      ? [
          {
            name: 'Filialga qaytarilgan',
            sum: sumOf(branches, (row) => row.reversed),
          },
        ]
      : []),
    {
      name: 'Kuryerga qaytarilgan',
      sum: sumOf(s.couriers, (row) => row.reversed ?? 0),
    },
  ];
  const rest = (rows: FlowRow[], total: number) =>
    money(total - sumOf(rows, (row) => row.sum));
  return {
    income: [
      ...income,
      { name: 'Boshqa kirim', sum: rest(income, incomeTotal) },
    ],
    incomeTotal,
    expense: [
      ...expense,
      {
        name:
          isMain || hq
            ? 'Boshqa chiqim'
            : "Boshqa chiqim (HQ'ga topshirish, xarajat)",
        sum: rest(expense, expenseTotal),
      },
    ],
    expenseTotal,
  };
}

// ───────────────────────── umumiy bo'laklar ─────────────────────────

/** Ulush ustuni: shu qator / JAMI qatori. */
const shareColumn = <T>(
  letter: string,
  totalRow: number,
  total: number,
  pick: (row: T) => number,
  span?: number,
): ReportColumn<T> => ({
  header: 'Ulush',
  fmt: F.pct,
  span,
  value: (row, r) =>
    formula(
      `IF(${letter}$${totalRow}=0,0,${letter}${r}/${letter}$${totalRow})`,
      total ? pick(row) / total : 0,
    ),
  totalValue: formula(`IF(${letter}${totalRow}=0,0,1)`, total ? 1 : 0),
});

function addFlowTable(
  ws: Worksheet,
  row: number,
  startColumn: number,
  spans: readonly [number, number, number],
  label: string,
  rows: readonly FlowRow[],
  total: number,
): ReportTableResult {
  const sumLetter = columnLetter(startColumn + spans[0]);
  const table = addTable(ws, row, {
    startColumn,
    zebra: false,
    total: true,
    rows,
    columns: [
      { header: label, span: spans[0], value: (item) => item.name },
      {
        header: "Summa, so'm",
        span: spans[1],
        fmt: F.somDash,
        bold: true,
        value: (item) => item.sum,
        sum: true,
      },
      shareColumn<FlowRow>(
        sumLetter,
        row + rows.length + 1,
        total,
        (item) => item.sum,
        spans[2],
      ),
    ],
  });
  const share = columnLetter(startColumn + spans[0] + spans[1]);
  addShareBars(ws, `${share}${table.first}:${share}${table.last}`);
  return table;
}

/** Jadval kataklaridagi ko'rsatkichni jadval jamiga ulaydi (bitta manba). */
const linkCell = (
  ws: Worksheet,
  row: number,
  column: number,
  text: string,
  result: number,
): void => {
  ws.getCell(row, column).value = formula(text, result);
};

interface SheetFrame {
  subtitle: string;
  tag: Pick<ReportBanner, 'right' | 'rightSub'>;
  footer: string;
}

interface EntityRow extends SliceTotals {
  n: number;
  name: string;
  lines: readonly GroupedLine[];
  balance: number | null;
}

const entityRows = <T extends BranchSlice | MarketSlice>(
  slices: readonly T[],
  id: (slice: T) => string,
): EntityRow[] =>
  [...slices]
    .sort((a, b) => b.total - a.total)
    .map((slice, i) => ({
      n: i + 1,
      name: slice.name ?? `#${id(slice)}`,
      lines: slice.payments,
      balance: slice.balance,
      ...sliceTotals(slice),
    }));

const groupsOf = (rows: readonly EntityRow[]): PaymentGroup[] =>
  rows.map(({ name, count, net, balance, lines }) => ({
    name,
    count,
    net,
    balance,
    lines,
  }));

const balanceTone = (row: EntityRow): ReportTone | undefined =>
  (row.balance ?? 0) < 0 ? 'danger' : undefined;

const numberColumn = <T extends { n: number }>(): ReportColumn<T> => ({
  header: '№',
  align: 'center',
  value: (row) => row.n,
});

/** «Smenalar orasida» jadvali (harakat bo'lsa). */
function addBetweenShifts(
  ws: Worksheet,
  row: number,
  s: ShiftReportSnapshot,
  o: {
    at: Span;
    split: number;
    title: string;
    note: (count: number) => string;
    spans: readonly [number, number, number, number];
    countColumn: boolean;
  },
): number {
  const gap = s.between_shifts;
  if (!gap || !gap.count) return row;
  const r = addSectionAt(ws, row, o.at, o.title, {
    note: o.note(gap.count),
    split: o.split,
    color: C.warning,
  });
  const columns: ReportColumn<typeof gap>[] = [
    {
      header: 'Boshlanishi',
      span: o.spans[0],
      fmt: F.dateTime,
      value: (item) => dateCell(item.from),
    },
    {
      header: 'Tugashi',
      span: o.spans[1],
      fmt: F.dateTime,
      value: (item) => dateCell(item.to),
    },
    {
      header: "Kirim, so'm",
      span: o.spans[2],
      fmt: F.som,
      bold: true,
      value: (item) => item.income,
    },
    {
      header: "Chiqim, so'm",
      span: o.spans[3],
      fmt: F.som,
      bold: true,
      value: (item) => item.expense,
    },
    ...(o.countColumn
      ? [
          {
            header: 'Amallar',
            fmt: F.int,
            value: (item: typeof gap) => item.count,
          },
        ]
      : []),
  ];
  return addTable(ws, r, {
    zebra: false,
    rows: [gap],
    columns,
    rowTone: () => 'warning',
  }).next;
}

// ───────────────────────── A1 — asosiy kassa ─────────────────────────

function mainNote(s: ShiftReportSnapshot): { text: string; tone: ReportTone } {
  const cash = s.cash.discrepancy;
  const card = s.card.discrepancy;
  if (s.close_reason === 'auto') {
    const uncounted = cash == null && card == null;
    return {
      text: uncounted
        ? `${autoClosedLabel(s.closed_at)}. Naqd ham, kartalar ham sanalmagan: farq hisoblanmadi, qoldiq — tizim bo'yicha.`
        : `${autoClosedLabel(s.closed_at)}.`,
      tone: 'warning',
    };
  }
  const parts = [
    { where: 'Naqdda', name: 'Naqd', value: cash, matched: 'Naqd pul mos.' },
    { where: 'Kartada', name: 'Karta', value: card, matched: 'Karta mos.' },
  ];
  const bad = parts.filter((part) => part.value);
  const none = parts.filter((part) => part.value == null);
  if (!bad.length) {
    return none.length
      ? {
          text: `${none.map((part) => part.name).join(' va ')} sanalmagan.`,
          tone: 'warning',
        }
      : { text: "Naqd ham, karta ham mos — farq yo'q.", tone: 'success' };
  }
  const text = [
    `${bad.map((part) => `${part.where} ${diffWord(part.value).toLowerCase()}`).join(', ')} bor.`,
    ...parts
      .filter((part) => !part.value)
      .map((part) =>
        part.value == null ? `${part.name} sanalmagan.` : part.matched,
      ),
    ...(card ? ["Qaysi kartada — «Kartalar» varag'ida."] : []),
  ].join(' ');
  return {
    text,
    tone: bad.some((part) => (part.value ?? 0) < 0) ? 'danger' : 'warning',
  };
}

function addMainSummary(
  workbook: Workbook,
  s: ShiftReportSnapshot,
  frame: SheetFrame,
): void {
  const auto = s.close_reason === 'auto';
  // B–E | F (oraliq) | G–J: chap va o'ng yarim.
  const ws = addReportSheet(
    workbook,
    'Xulosa',
    [14.3, 11.7, 14.5, 10, 2, 14.3, 11.7, 14.5, 10.5],
    { tab: C.action, footer: frame.footer },
  );
  ws.pageSetup.fitToHeight = 1;
  let r = addShiftBanner(ws, {
    title: 'Asosiy kassa — smena hisoboti',
    subtitle: periodText(s),
    ...frame.tag,
  });
  r = addMetaAt(
    ws,
    r,
    [
      { label: 'Kassa', value: 'Asosiy kassa' },
      { label: 'Smena', value: `#${s.shift_id}` },
      { label: 'Ochgan', value: openedText(s) },
      { label: 'Ochilgan', value: dateCell(s.opened_at), fmt: F.dateTime },
      {
        label: 'Yopilish',
        value: closedText(s),
        ...(auto ? { tone: 'warning' as const } : {}),
      },
      { label: 'Yopilgan', value: dateCell(s.closed_at), fmt: F.dateTime },
    ],
    [
      [
        [2, 2],
        [3, 5],
      ],
      [
        [7, 7],
        [8, 10],
      ],
    ],
  );
  const cash = blockOf(s.cash);
  const card = blockOf(s.card);
  const total = (pick: (b: Block) => number) => money(pick(cash) + pick(card));
  const diff =
    cash.diff != null && card.diff != null
      ? money(cash.diff + card.diff)
      : null;
  const counted = diff != null;
  const balance = counted ? total((b) => b.closing) : total((b) => b.expected);
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 3],
      label: counted ? "Sanalgan qoldiq, so'm" : "Kutilgan qoldiq, so'm",
      value: balance,
      tone: 'action',
      sub: counted ? 'Naqd va karta birga' : "Tizim bo'yicha, sanalmagan",
    },
    {
      at: [4, 6],
      label: "Farq, so'm",
      value: diff ?? 'sanalmadi',
      fmt: F.signed,
      tone: diffTone(diff),
      sub:
        diff != null
          ? diffSub(diff, 'Kassa mos')
          : cash.diff == null && card.diff == null
            ? 'Kassir pulni sanamagan'
            : "To'liq sanalmagan",
    },
    {
      at: [7, 8],
      label: "Kirim, so'm",
      value: total((b) => b.income),
      tone: 'success',
      sub: `${(s.branches ?? []).length} ta filial, ${s.couriers.length} ta kuryer`,
    },
    {
      at: [9, 10],
      label: "Chiqim, so'm",
      value: total((b) => b.expense),
      tone: 'neutral',
      sub: `${s.markets.length} ta market va boshqa`,
    },
  ]);
  const note = mainNote(s);
  r = addNote(ws, r, note.text, note.tone);

  r = addSectionAt(ws, r, [2, 10], 'Naqd va karta', { note: "so'm", split: 8 });
  const hasConversion = Boolean(cash.conversion || card.conversion);
  const open = r + 1;
  const rows = {
    open,
    income: open + 1,
    expense: open + 2,
    conversion: open + 3,
    expected: open + (hasConversion ? 4 : 3),
    counted: open + (hasConversion ? 5 : 4),
    diff: open + (hasConversion ? 6 : 5),
  };
  const both = (pick: (b: Block) => number) => [
    pick(cash),
    pick(card),
    (k: number) => formula(`D${k}+G${k}`, total(pick)),
  ];
  const tones = [diffTone(cash.diff), diffTone(card.diff), diffTone(diff)];
  r = addStatement(
    ws,
    r,
    [
      { header: "Ko'rsatkich", at: [2, 3] },
      { header: 'Naqd', at: [4, 6] },
      { header: 'Karta', at: [7, 8] },
      { header: 'Jami', at: [9, 10] },
    ],
    [
      { label: "Ochilish qoldig'i", cells: both((b) => b.opening) },
      {
        label: 'Kirim (+)',
        cells: both((b) => b.income),
        tone: 'success',
      },
      {
        label: 'Chiqim (−)',
        cells: both((b) => b.expense),
        tone: 'danger',
      },
      ...(hasConversion
        ? [
            {
              label: "Naqd ↔ karta o'tkazma (±)",
              cells: both((b) => b.conversion),
              fmt: F.signed,
            },
          ]
        : []),
      {
        label: 'Kutilgan qoldiq',
        kind: 'sub' as const,
        cells: (
          [
            ['D', cash.expected],
            ['G', card.expected],
            ['I', total((b) => b.expected)],
          ] as const
        ).map(([letter, result]) =>
          formula(
            `${letter}${rows.open}+${letter}${rows.income}-${letter}${rows.expense}${hasConversion ? `+${letter}${rows.conversion}` : ''}`,
            result,
          ),
        ),
      },
      {
        label: 'Sanalgan (topshirilgan)',
        cells: [
          cash.diff == null ? 'sanalmadi' : cash.closing,
          card.diff == null ? 'sanalmadi' : card.closing,
          counted
            ? formula(
                `D${rows.counted}+G${rows.counted}`,
                total((b) => b.closing),
              )
            : 'sanalmadi',
        ],
      },
      {
        label: 'Farq',
        kind: 'final' as const,
        fmt: F.signed,
        tones,
        cells: (
          [
            ['D', cash.diff],
            ['G', card.diff],
            ['I', diff],
          ] as const
        ).map(([letter, value]) =>
          value == null
            ? '—'
            : formula(
                `${letter}${rows.counted}-${letter}${rows.expected}`,
                value,
              ),
        ),
      },
      {
        label: 'Holat',
        kind: 'status' as const,
        tones,
        cells: [diffWord(cash.diff), diffWord(card.diff), diffWord(diff)],
      },
    ],
  );
  linkCell(
    ws,
    kpiRow + 1,
    2,
    `I${counted ? rows.counted : rows.expected}`,
    balance,
  );
  if (diff != null) linkCell(ws, kpiRow + 1, 4, `I${rows.diff}`, diff);
  linkCell(
    ws,
    kpiRow + 1,
    7,
    `I${rows.income}`,
    total((b) => b.income),
  );
  linkCell(
    ws,
    kpiRow + 1,
    9,
    `I${rows.expense}`,
    total((b) => b.expense),
  );

  r = addBetweenShifts(ws, r, s, {
    at: [2, 10],
    split: 6,
    title: 'Smenalar orasida (smenasiz harakat)',
    note: () => "ochilish qoldig'iga kirgan",
    spans: [2, 3, 1, 2],
    countColumn: true,
  });

  const flows = moneyFlows(s);
  addSectionAt(ws, r, [2, 5], 'Kirim manbalari');
  addSectionAt(ws, r, [7, 10], "Chiqim yo'nalishlari");
  r += 1;
  const income = addFlowTable(
    ws,
    r,
    2,
    [2, 1, 1],
    'Manba',
    flows.income,
    flows.incomeTotal,
  );
  const expense = addFlowTable(
    ws,
    r,
    7,
    [2, 1, 1],
    "Yo'nalish",
    flows.expense,
    flows.expenseTotal,
  );
  addSignaturesAt(ws, Math.max(income.next, expense.next), [
    [handedText(s), [2, 3]],
    ['Qabul qildi', [5, 7]],
    ['Sana', [9, 10]],
  ]);
}

/**
 * «Filiallar» / «Marketlar»: KPI, jamlanma (naqd, karta, qaytarilgan, sof,
 * ulush, qoldiq) va guruhlangan to'lovlar.
 */
function addEntitySheet(
  workbook: Workbook,
  frame: SheetFrame,
  rows: readonly EntityRow[],
  o: {
    sheet: string;
    title: string;
    who: string;
    unit: string;
    netWord: string;
    grossWord: string;
    balanceWord: string;
    balanceKpi: string;
    tone: ReportTone;
    card: boolean;
  },
): void {
  const ws = addReportSheet(
    workbook,
    o.sheet,
    [5, 9.5, 10.5, 9.5, 14, 14, 13, 14.5, 10, 14.5],
    { footer: frame.footer },
  );
  let r = addShiftBanner(ws, {
    title: o.title,
    subtitle: frame.subtitle,
    ...frame.tag,
  });
  const net = sumOf(rows, (row) => row.net);
  const gross = sumOf(rows, (row) => row.gross);
  const reversed = sumOf(rows, (row) => row.reversed);
  const balance = sumOf(rows, (row) => row.balance);
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: `${o.netWord}, so'm`,
      value: net,
      tone: o.tone,
      sub: `${rows.length} ta ${o.unit}, ${sumOf(rows, (row) => row.count)} ta to'lov`,
    },
    {
      at: [5, 6],
      label: `${o.grossWord}, so'm`,
      value: gross,
      sub: 'Naqd va karta, yalpi',
    },
    {
      at: [7, 8],
      label: "Qaytarilgan, so'm",
      value: reversed,
      ...(reversed ? { tone: 'danger' as const } : {}),
      sub: 'Yalpi summadan ayirilgan',
    },
    {
      at: [9, 11],
      label: `${o.balanceKpi}, so'm`,
      value: balance,
      sub: 'Hisobot vaqtida',
    },
  ]);
  r = addSection(
    ws,
    r,
    `${o.who}lar bo'yicha jamlanma`,
    'Sof = naqd + karta − qaytarilgan',
  );
  const table = addTable<EntityRow>(ws, r, {
    total: true,
    totalLabel: '',
    rows,
    columns: [
      numberColumn(),
      {
        header: o.who,
        span: 2,
        bold: true,
        value: (row) => row.name,
        totalValue: 'JAMI',
      },
      {
        header: "To'lov soni",
        fmt: F.int,
        value: (row) => row.count,
        sum: true,
      },
      {
        header: "Naqd, so'm",
        fmt: F.somDash,
        value: (row) => row.cash,
        sum: true,
      },
      {
        header: "Karta, so'm",
        fmt: F.somDash,
        value: (row) => row.card,
        sum: true,
      },
      {
        header: "Qaytarilgan, so'm",
        fmt: F.somDash,
        value: (row) => row.reversed,
        sum: true,
        tone: (row) => (row.reversed ? 'danger' : undefined),
      },
      {
        header: "Sof, so'm",
        fmt: F.som,
        bold: true,
        value: (row, k) => formula(`F${k}+G${k}-H${k}`, row.net),
        sum: true,
        tone: (row) => (row.net < 0 ? 'danger' : undefined),
      },
      shareColumn<EntityRow>('I', r + rows.length + 1, net, (row) => row.net),
      {
        header: `${o.balanceWord}, so'm`,
        fmt: F.som,
        align: 'right',
        value: (row) => row.balance ?? '—',
        sum: true,
        tone: balanceTone,
      },
    ],
  });
  if (table.totalRow) {
    const at = table.totalRow;
    addShareBars(ws, `J${table.first}:J${table.last}`);
    linkCell(ws, kpiRow + 1, 2, `I${at}`, net);
    linkCell(ws, kpiRow + 1, 5, `F${at}+G${at}`, gross);
    linkCell(ws, kpiRow + 1, 7, `H${at}`, reversed);
    linkCell(ws, kpiRow + 1, 9, `K${at}`, balance);
  }
  r = addSection(
    ws,
    table.next,
    `To'lovlar — ${o.unit}lar bo'yicha`,
    "Manfiy summa — qaytarilgan to'lov",
  );
  const columns: GroupedColumn[] = o.card
    ? [
        { key: 'n', header: '№', at: [2, 2], align: 'center' },
        { key: 'name', header: `${o.who} / vaqt`, at: [3, 4] },
        { key: 'method', header: 'Usul', at: [5, 6] },
        { key: 'card', header: 'Karta', at: [7, 8] },
        { key: 'amount', header: "Summa, so'm", at: [9, 9], align: 'right' },
        { key: 'note', header: 'Izoh', at: [10, 10], align: 'center' },
        {
          key: 'balance',
          header: `${o.balanceWord}, so'm`,
          at: [11, 11],
          align: 'right',
        },
      ]
    : [
        { key: 'n', header: '№', at: [2, 2], align: 'center' },
        { key: 'name', header: `${o.who} / vaqt`, at: [3, 4] },
        { key: 'method', header: 'Usul', at: [5, 6] },
        { key: 'amount', header: "Summa, so'm", at: [7, 8], align: 'right' },
        { key: 'note', header: 'Izoh', at: [9, 9], align: 'center' },
        {
          key: 'balance',
          header: `${o.balanceWord}, so'm`,
          at: [10, 11],
          align: 'right',
        },
      ];
  addGroupedPayments(ws, r, columns, groupsOf(rows));
}

/** «Kuryerlar»: topshirgan, qaytarilgan, sof, qolgan qarz (`wide` — ulush ham). */
function addCourierSheet(
  workbook: Workbook,
  frame: SheetFrame,
  couriers: readonly CourierSlice[],
  wide: boolean,
): void {
  const ws = addReportSheet(
    workbook,
    'Kuryerlar',
    wide
      ? [5, 9.5, 15, 10, 15, 14, 15, 10, 15]
      : [5, 9.5, 9, 9, 13, 13, 13, 13],
    { footer: frame.footer },
  );
  let r = addShiftBanner(ws, {
    title: 'Kuryerlardan qabul',
    subtitle: frame.subtitle,
    ...frame.tag,
  });
  const rows = [...couriers]
    .sort((a, b) => b.total - a.total)
    .map((slice, i) => ({
      n: i + 1,
      name: slice.name ?? `#${slice.courier_id}`,
      count: slice.count,
      received: courierReceived(slice),
      reversed: slice.reversed ?? 0,
      net: slice.total,
      debt: slice.remaining_debt,
    }));
  type Row = (typeof rows)[number];
  const net = sumOf(rows, (row) => row.net);
  const reversed = sumOf(rows, (row) => row.reversed);
  const debt = sumOf(rows, (row) => row.debt);
  const last = lastColumn(ws);
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: "Kuryerlardan sof qabul, so'm",
      value: net,
      tone: 'success',
      sub: `${rows.length} ta kuryer, ${sumOf(rows, (row) => row.count)} ta to'lov`,
    },
    {
      at: [5, 7],
      label: "Qaytarilgan, so'm",
      value: reversed,
      ...(reversed ? { tone: 'danger' as const } : {}),
      sub: 'Sof summadan ayirilgan',
    },
    {
      at: [8, last],
      label: "Qolgan qarz, so'm",
      value: debt,
      ...(debt > 0 ? { tone: 'warning' as const } : {}),
      sub: "Kuryerlar qo'lidagi pul",
    },
  ]);
  r = addSection(ws, r, "Kuryerlar ro'yxati", 'Sof = topshirgan − qaytarilgan');
  const table = addTable<Row>(ws, r, {
    total: true,
    totalLabel: '',
    rows,
    empty: 'Bu smenada kuryerdan pul qabul qilinmagan',
    columns: [
      numberColumn(),
      {
        header: 'Kuryer',
        span: 2,
        bold: true,
        value: (row) => row.name,
        totalValue: 'JAMI',
      },
      {
        header: "To'lov soni",
        fmt: F.int,
        value: (row) => row.count,
        sum: true,
      },
      {
        header: "Topshirgan, so'm",
        fmt: F.som,
        value: (row) => row.received,
        sum: true,
      },
      {
        header: "Qaytarilgan, so'm",
        fmt: F.somDash,
        value: (row) => row.reversed,
        sum: true,
        tone: (row) => (row.reversed ? 'danger' : undefined),
      },
      {
        header: "Sof, so'm",
        fmt: F.som,
        bold: true,
        value: (row, k) => formula(`F${k}-G${k}`, row.net),
        sum: true,
        tone: (row) => (row.net < 0 ? 'danger' : undefined),
      },
      ...(wide
        ? [shareColumn<Row>('H', r + rows.length + 1, net, (row) => row.net)]
        : []),
      {
        header: "Qolgan qarz, so'm",
        fmt: F.som,
        align: 'right',
        value: (row) => row.debt ?? '—',
        sum: true,
        tone: (row) =>
          (row.debt ?? 0) > 0
            ? 'warning'
            : (row.debt ?? 0) < 0
              ? 'danger'
              : undefined,
      },
    ],
  });
  if (table.totalRow) {
    const at = table.totalRow;
    if (wide) addShareBars(ws, `I${table.first}:I${table.last}`);
    linkCell(ws, kpiRow + 1, 2, `H${at}`, net);
    linkCell(ws, kpiRow + 1, 5, `G${at}`, reversed);
    linkCell(ws, kpiRow + 1, 8, `${columnLetter(last)}${at}`, debt);
  }
}

function addCardSheet(
  workbook: Workbook,
  frame: SheetFrame,
  s: ShiftReportSnapshot,
): void {
  const ws = addReportSheet(
    workbook,
    'Kartalar',
    [5, 9.5, 15, 18, 16, 14.5, 17],
    { footer: frame.footer },
  );
  let r = addShiftBanner(ws, {
    title: 'Kartalar va hisoblar',
    subtitle: frame.subtitle,
    ...frame.tag,
  });
  const auto = s.close_reason === 'auto';
  const rows = s.accounts.map((account, i) => ({
    n: i + 1,
    name: `${account.name}${account.last4 ? ` •${account.last4}` : ''}`,
    system: account.expected_balance,
    entered: account.entered_balance,
    diff: account.difference,
    ai: account.ai_status,
  }));
  type Row = (typeof rows)[number];
  const any = rows.some((row) => row.entered != null);
  const system = sumOf(rows, (row) => row.system);
  const entered = sumOf(rows, (row) => row.entered);
  const diff = any ? sumOf(rows, (row) => row.diff) : null;
  const bad = rows.filter((row) => row.diff);
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: "Tizim qoldig'i, so'm",
      value: system,
      sub: `${rows.length} ta karta`,
    },
    {
      at: [5, 6],
      label: "Kiritilgan, so'm",
      value: any ? entered : rows.length ? 'kiritilmadi' : '—',
      ...(any || !rows.length ? {} : { tone: 'warning' as const }),
      sub: any
        ? 'Kassir kiritgan qoldiq'
        : !rows.length
          ? ''
          : auto
            ? 'Smena avtomatik yopilgan'
            : 'Kassir kiritmagan',
    },
    {
      at: [7, 8],
      label: "Farq, so'm",
      value: diff ?? (rows.length ? 'sanalmadi' : '—'),
      fmt: F.signed,
      ...(rows.length ? { tone: diffTone(diff) } : {}),
      sub: !rows.length
        ? ''
        : diff == null
          ? "Solishtirib bo'lmaydi"
          : bad.length
            ? `${bad.length} ta kartada farq`
            : 'Hamma karta mos',
    },
  ]);
  r = addSection(ws, r, "Kartalar ro'yxati", 'Farq = kiritilgan − tizim');
  const table = addTable<Row>(ws, r, {
    total: true,
    totalLabel: '',
    zebra: false,
    rowHeight: 20,
    rows,
    empty: "Karta yo'q",
    rowTone: (row) =>
      row.diff ? (row.diff < 0 ? 'danger' : 'warning') : undefined,
    columns: [
      numberColumn(),
      {
        header: 'Karta',
        span: 2,
        bold: true,
        value: (row) => row.name,
        totalValue: 'JAMI',
      },
      {
        header: "Tizim qoldig'i, so'm",
        fmt: F.som,
        value: (row) => row.system ?? '—',
        sum: true,
      },
      {
        header: "Kiritilgan, so'm",
        fmt: F.som,
        value: (row) => row.entered ?? '—',
        ...(any ? { sum: true } : { totalValue: '—' }),
      },
      {
        header: "Farq, so'm",
        fmt: F.signed,
        bold: true,
        value: (row, k) =>
          row.diff == null ? '—' : formula(`F${k}-E${k}`, row.diff),
        tone: (row) => (row.diff == null ? 'neutral' : diffTone(row.diff)),
        ...(any ? { sum: true } : { totalValue: '—' }),
      },
      {
        header: 'AI natijasi',
        badge: true,
        align: 'center',
        value: (row) => aiTitle(row.ai),
        tone: (row) => AI_TONES[row.ai] ?? 'neutral',
      },
    ],
  });
  if (table.totalRow) {
    linkCell(ws, kpiRow + 1, 2, `E${table.totalRow}`, system);
    if (diff != null) {
      linkCell(ws, kpiRow + 1, 5, `F${table.totalRow}`, entered);
      linkCell(ws, kpiRow + 1, 7, `G${table.totalRow}`, diff);
      ws.getCell(table.totalRow, 7).font = reportFont({
        bold: true,
        color: REPORT_TONES[diffTone(diff)][0],
      });
      for (let k = table.first; k <= table.totalRow; k += 1) {
        const cell = ws.getCell(k, 7);
        cell.numFmt = moneyFmt(cell.value, F.signed);
      }
    }
  }
  if (bad.length) {
    const short = bad.some((row) => (row.diff ?? 0) < 0);
    addNote(
      ws,
      table.next,
      short
        ? 'Qizil qator — kassir kiritgan qoldiq tizimdagidan kam. Karta chekini qayta tekshiring.'
        : "Sariq qator — kassir kiritgan qoldiq tizimdagidan ko'p. Karta chekini qayta tekshiring.",
      short ? 'danger' : 'warning',
    );
  } else if (rows.length && !any) {
    addNote(
      ws,
      table.next,
      `Kartalar qoldig'i kiritilmagan${auto ? ' — smena avtomatik yopilgan' : ''}. Farq hisoblanmadi.`,
      'warning',
    );
  }
}

function buildMainXlsx(s: ShiftReportSnapshot): Workbook {
  const workbook = createReport(`Asosiy kassa — smena #${s.shift_id}`);
  const frame: SheetFrame = {
    subtitle: `Asosiy kassa · ${periodText(s)}`,
    tag: closeTag(s),
    footer: `Asosiy kassa · Smena #${s.shift_id}`,
  };
  addMainSummary(workbook, s, frame);
  const branches = entityRows(s.branches ?? [], (slice) => slice.branch_id);
  if (branches.length) {
    addEntitySheet(workbook, frame, branches, {
      sheet: 'Filiallar',
      title: 'Filiallardan qabul',
      who: 'Filial',
      unit: 'filial',
      netWord: 'Filiallardan sof qabul',
      grossWord: 'Topshirilgan',
      balanceWord: "Kassa qoldig'i",
      balanceKpi: 'Filial kassalarida qolgan',
      tone: 'success',
      card: false,
    });
  }
  addCourierSheet(workbook, frame, s.couriers, true);
  addEntitySheet(
    workbook,
    frame,
    entityRows(s.markets, (slice) => slice.market_id),
    {
      sheet: 'Marketlar',
      title: "Marketlarga to'lovlar",
      who: 'Market',
      unit: 'market',
      netWord: "Marketlarga sof to'lov",
      grossWord: "To'langan",
      balanceWord: 'Qoldiq',
      balanceKpi: 'Marketlarga qolgan qarz',
      tone: 'action',
      card: true,
    },
  );
  addCardSheet(workbook, frame, s);
  return workbook;
}

// ───────────────────────── A2 — filial kassasi ─────────────────────────

const branchNote = (
  s: ShiftReportSnapshot,
): { text: string; tone: ReportTone } => {
  const diff = s.cash.discrepancy;
  if (s.close_reason === 'auto') {
    return {
      text:
        diff == null
          ? `${autoClosedLabel(s.closed_at)}. Pul sanalmagan, farq hisoblanmadi.`
          : `${autoClosedLabel(s.closed_at)}.`,
      tone: 'warning',
    };
  }
  const text =
    diff == null
      ? 'Pul sanalmagan — farq hisoblanmadi.'
      : diff < 0
        ? 'Kamomad: sanalgan pul kutilgan qoldiqdan kam.'
        : diff > 0
          ? "Ortiqcha: sanalgan pul kutilgan qoldiqdan ko'p."
          : "Kassa mos — farq yo'q.";
  return { text, tone: diffTone(diff) };
};

/** Nol qatorlarsiz (hammasi nol bo'lsa — birinchisi qoladi). */
const visibleFlows = (rows: FlowRow[]): FlowRow[] => {
  const shown = rows.filter((row) => row.sum);
  return shown.length ? shown : rows.slice(0, 1);
};

function addBranchSummary(
  workbook: Workbook,
  s: ShiftReportSnapshot,
  frame: SheetFrame,
  title: string,
): void {
  const auto = s.close_reason === 'auto';
  // 63HO6cBU — filial smenasi bitta jami (karta bloki yo'q).
  const b = blockOf(s.cash);
  const ws = addReportSheet(workbook, 'Xulosa', [14.3, 13, 13, 13, 13, 13], {
    tab: C.action,
    footer: frame.footer,
  });
  ws.pageSetup.fitToHeight = 1;
  let r = addShiftBanner(ws, {
    title,
    subtitle: `Smena hisoboti · ${periodText(s)}`,
    ...frame.tag,
  });
  r = addMetaAt(
    ws,
    r,
    [
      { label: 'Ochgan', value: openedText(s) },
      { label: 'Ochilgan', value: dateCell(s.opened_at), fmt: F.dateTime },
      {
        label: 'Yopilish',
        value: closedText(s, true),
        ...(auto ? { tone: 'warning' as const } : {}),
      },
      { label: 'Yopilgan', value: dateCell(s.closed_at), fmt: F.dateTime },
    ],
    [
      [
        [2, 2],
        [3, 4],
      ],
      [
        [5, 5],
        [6, 7],
      ],
    ],
  );
  const counted = b.diff != null;
  const balance = counted ? b.closing : b.expected;
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: counted ? "Sanalgan qoldiq, so'm" : "Kutilgan qoldiq, so'm",
      value: balance,
      tone: 'action',
      sub: counted ? 'Kassir topshirgan' : "Tizim bo'yicha",
      size: 17,
    },
    {
      at: [5, 7],
      label: "Farq, so'm",
      value: b.diff ?? 'sanalmadi',
      fmt: F.signed,
      tone: diffTone(b.diff),
      sub:
        b.diff == null
          ? 'Kassir pulni sanamagan'
          : diffSub(b.diff, 'Kassa mos'),
      size: 17,
    },
  ]);
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: "Kirim, so'm",
      value: b.income,
      tone: 'success',
      sub: `${s.couriers.length} ta kuryer`,
    },
    {
      at: [5, 7],
      label: "Chiqim, so'm",
      value: b.expense,
      tone: 'neutral',
      sub: `${s.markets.length} ta market va boshqa`,
    },
  ]);
  const note = branchNote(s);
  r = addNote(ws, r, note.text, note.tone);

  r = addSectionAt(ws, r, [2, 7], 'Kassa hisobi', { note: "so'm", split: 5 });
  const open = r + 1;
  const shift = b.conversion ? 1 : 0;
  const rows = {
    open,
    income: open + 1,
    expense: open + 2,
    conversion: open + 3,
    expected: open + 3 + shift,
    counted: open + 4 + shift,
    diff: open + 5 + shift,
  };
  r = addStatement(
    ws,
    r,
    [
      { header: "Ko'rsatkich", at: [2, 5] },
      { header: 'Jami', at: [6, 7] },
    ],
    [
      { label: "Ochilish qoldig'i", cells: [b.opening] },
      { label: 'Kirim (+)', cells: [b.income], tone: 'success' },
      { label: 'Chiqim (−)', cells: [b.expense], tone: 'danger' },
      ...(b.conversion
        ? [
            {
              label: 'Boshqa tuzatish (±)',
              cells: [b.conversion],
              fmt: F.signed,
            },
          ]
        : []),
      {
        label: 'Kutilgan qoldiq',
        kind: 'sub' as const,
        cells: [
          formula(
            `F${rows.open}+F${rows.income}-F${rows.expense}${b.conversion ? `+F${rows.conversion}` : ''}`,
            b.expected,
          ),
        ],
      },
      {
        label: 'Sanalgan (topshirilgan)',
        cells: [counted ? b.closing : 'sanalmadi'],
      },
      {
        label: 'Farq',
        kind: 'final' as const,
        fmt: F.signed,
        tones: [diffTone(b.diff)],
        cells: [
          b.diff == null
            ? '—'
            : formula(`F${rows.counted}-F${rows.expected}`, b.diff),
        ],
      },
      {
        label: 'Holat',
        kind: 'status' as const,
        tones: [diffTone(b.diff)],
        cells: [diffWord(b.diff)],
      },
    ],
  );
  linkCell(
    ws,
    kpiRow + 1,
    2,
    `F${counted ? rows.counted : rows.expected}`,
    balance,
  );
  if (b.diff != null) linkCell(ws, kpiRow + 1, 5, `F${rows.diff}`, b.diff);
  linkCell(ws, kpiRow + 5, 2, `F${rows.income}`, b.income);
  linkCell(ws, kpiRow + 5, 5, `F${rows.expense}`, b.expense);

  r = addBetweenShifts(ws, r, s, {
    at: [2, 7],
    split: 4,
    title: 'Smenalar orasida (smenasiz)',
    note: (count) => `${count} ta amal · ochilish qoldig'iga kirgan`,
    spans: [2, 2, 1, 1],
    countColumn: false,
  });

  const flows = moneyFlows(s);
  r = addSectionAt(ws, r, [2, 7], 'Kirim manbalari');
  r = addFlowTable(
    ws,
    r,
    2,
    [3, 2, 1],
    'Manba',
    visibleFlows(flows.income),
    flows.incomeTotal,
  ).next;
  r = addSectionAt(ws, r, [2, 7], "Chiqim yo'nalishlari");
  r = addFlowTable(
    ws,
    r,
    2,
    [3, 2, 1],
    "Yo'nalish",
    visibleFlows(flows.expense),
    flows.expenseTotal,
  ).next;
  addSignatures(ws, r, [handedText(s), 'Qabul qildi']);
}

function addBranchMarkets(
  workbook: Workbook,
  frame: SheetFrame,
  s: ShiftReportSnapshot,
): void {
  const ws = addReportSheet(
    workbook,
    'Marketlar',
    [5, 9.5, 10.5, 15, 16.5, 16, 13],
    { footer: frame.footer },
  );
  let r = addShiftBanner(ws, {
    title: "Marketlarga to'lovlar",
    subtitle: frame.subtitle,
    ...frame.tag,
  });
  const rows = entityRows(s.markets, (slice) => slice.market_id);
  const net = sumOf(rows, (row) => row.net);
  const reversed = sumOf(rows, (row) => row.reversed);
  const balance = sumOf(rows, (row) => row.balance);
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: "Marketlarga sof to'lov, so'm",
      value: net,
      tone: 'action',
      sub: `${rows.length} ta market, ${sumOf(rows, (row) => row.count)} ta to'lov`,
    },
    {
      at: [5, 6],
      label: "Qaytarilgan, so'm",
      value: reversed,
      ...(reversed ? { tone: 'danger' as const } : {}),
      sub: 'Sof summadan ayirilgan',
    },
    {
      at: [7, 8],
      label: "Marketlarga qolgan qarz, so'm",
      value: balance,
      sub: 'Hisobot vaqtida',
    },
  ]);
  r = addSection(ws, r, "Marketlar bo'yicha jamlanma");
  const table = addTable<EntityRow>(ws, r, {
    total: true,
    totalLabel: '',
    rows,
    empty: "Bu smenada marketga to'lov qilinmagan",
    columns: [
      numberColumn(),
      {
        header: 'Market',
        span: 2,
        bold: true,
        value: (row) => row.name,
        totalValue: 'JAMI',
      },
      {
        header: "Sof to'lov, so'm",
        fmt: F.som,
        bold: true,
        value: (row) => row.net,
        sum: true,
        tone: (row) => (row.net < 0 ? 'danger' : undefined),
      },
      {
        header: "To'lov soni",
        fmt: F.int,
        value: (row) => row.count,
        sum: true,
      },
      {
        header: "Qaytarilgan, so'm",
        fmt: F.somDash,
        value: (row) => row.reversed,
        sum: true,
        tone: (row) => (row.reversed ? 'danger' : undefined),
      },
      {
        header: "Qoldiq, so'm",
        fmt: F.som,
        align: 'right',
        value: (row) => row.balance ?? '—',
        sum: true,
        tone: balanceTone,
      },
    ],
  });
  if (table.totalRow) {
    linkCell(ws, kpiRow + 1, 2, `E${table.totalRow}`, net);
    linkCell(ws, kpiRow + 1, 5, `G${table.totalRow}`, reversed);
    linkCell(ws, kpiRow + 1, 7, `H${table.totalRow}`, balance);
  }
  r = addSection(ws, table.next, "To'lovlar — marketlar bo'yicha");
  addGroupedPayments(
    ws,
    r,
    [
      { key: 'n', header: '№', at: [2, 2], align: 'center' },
      { key: 'name', header: 'Market / vaqt', at: [3, 4] },
      { key: 'amount', header: "Summa, so'm", at: [5, 5], align: 'right' },
      { key: 'method', header: 'Usul', at: [6, 6], align: 'center' },
      { key: 'card', header: 'Karta', at: [7, 7] },
      { key: 'note', header: 'Izoh', at: [8, 8], align: 'center' },
    ],
    groupsOf(rows),
  );
}

function buildBranchXlsx(s: ShiftReportSnapshot): Workbook {
  const label = branchTitle(
    s.branch_name,
    `Filial kassasi #${s.cashbox_user_id}`,
  );
  const workbook = createReport(`${label} — smena #${s.shift_id}`);
  const frame: SheetFrame = {
    subtitle: `${label} · ${periodText(s)}`,
    tag: closeTag(s),
    footer: `${label} · Smena #${s.shift_id}`,
  };
  addBranchSummary(
    workbook,
    s,
    frame,
    s.branch_name?.trim() ? `${label} kassasi` : label,
  );
  addCourierSheet(workbook, frame, s.couriers, false);
  addBranchMarkets(workbook, frame, s);
  return workbook;
}

/** To'liq smena hisoboti: asosiy kassa (A1) yoki filial kassasi (A2). */
export async function buildXlsx(
  snapshot: ShiftReportSnapshot,
): Promise<Buffer> {
  return reportToBuffer(
    snapshot.cashbox_type === 'branch'
      ? buildBranchXlsx(snapshot)
      : buildMainXlsx(snapshot),
  );
}

// ───────────────────────── A3 / A4 — bitta varaqli ko'chirma ─────────────────────────

/** B–D | E–F | G–H — uch teng karta. */
const SLIP_WIDTHS = [5, 9.5, 11.5, 15, 18.5, 19, 12];
const SLIP_META: ReadonlyArray<readonly [Span, Span]> = [
  [
    [2, 3],
    [4, 5],
  ],
  [
    [6, 6],
    [7, 8],
  ],
];

interface SlipRow extends GroupedLine {
  n: number | '';
}

const slipRows = (lines: readonly GroupedLine[]): SlipRow[] => {
  let n = 0;
  return lines.map((line) => ({ ...line, n: line.reversed ? '' : ++n }));
};

const slipColumns = (card: boolean): ReportColumn<SlipRow>[] => [
  { header: '№', align: 'center', value: (row) => row.n },
  {
    header: 'Vaqt',
    span: 2,
    fmt: F.dateTime,
    value: (row) => dateCell(row.at),
  },
  {
    header: "Summa, so'm",
    fmt: F.som,
    bold: true,
    value: (row) => row.amount,
    tone: (row) => (row.amount < 0 ? 'danger' : undefined),
  },
  {
    header: 'Usul',
    align: 'center',
    value: (row) => methodTitle(row.payment_method),
    tone: (row) => (isCashLine(row) ? undefined : 'info'),
  },
  ...(card
    ? [
        {
          header: 'Karta',
          color: C.muted,
          value: (row: SlipRow) =>
            row.card_name || (isCashLine(row) ? '' : '—'),
        },
      ]
    : []),
  {
    header: 'Izoh',
    ...(card ? { align: 'center' as const } : { span: 2 }),
    bold: true,
    value: (row) => (row.reversed ? 'Qaytarildi' : ''),
    tone: (row) => (row.reversed ? 'danger' : undefined),
  },
];

/** Yakun bloki; `net` — jami katagi manzili (KPI shunga ulanadi). */
function addSlipTotals(
  ws: Worksheet,
  slice: { payments: readonly GroupedLine[]; balance: number | null },
  totals: SliceTotals,
  table: ReportTableResult,
  words: { total: string; balance: string },
): { next: number; net: string } {
  const sums = `$E$${table.first}:$E$${table.last}`;
  const methods = `$F$${table.first}:$F$${table.last}`;
  const has = slice.payments.length > 0;
  const rows: TotalsRow[] = [
    ...(has
      ? [
          {
            label: 'Naqd',
            value: formula(
              `SUMIFS(${sums},${methods},"Naqd",${sums},">0")`,
              totals.cash,
            ),
          },
          {
            label: 'Karta',
            value: formula(
              `SUMIFS(${sums},${methods},"<>Naqd",${sums},">0")`,
              totals.card,
            ),
          },
        ]
      : []),
    ...(totals.reversed
      ? [
          {
            label: 'Qaytarilgan',
            value: formula(`SUMIF(${sums},"<0")`, -totals.reversed),
            tone: 'danger' as const,
          },
        ]
      : []),
    {
      label: words.total,
      value: has ? formula(`SUM(${sums})`, totals.net) : totals.net,
      kind: 'total',
    },
    ...(slice.balance != null
      ? [
          {
            label: words.balance,
            value: slice.balance,
            kind: 'balance' as const,
          },
        ]
      : []),
  ];
  const at = rows.findIndex((row) => row.kind === 'total');
  return {
    next: addTotalsAt(ws, table.next, rows, [
      [5, 6],
      [7, 8],
    ]),
    net: `G${table.next + at}`,
  };
}

const balanceKpi = (
  balance: number | null,
): { value: CellValue; tone: ReportTone } => ({
  value: balance ?? '—',
  tone: (balance ?? 0) < 0 ? 'danger' : 'action',
});

/**
 * Filial Excel'i (asosiy kassa smenasi) — FAQAT shu filial HQ'ga topshirgan
 * pul (`slice`): har to'lov (summa, usul, vaqt, izoh), jami, kassa qoldig'i.
 */
export async function buildBranchSliceXlsx(
  snapshot: ClosedShift,
  slice: BranchSlice,
): Promise<Buffer> {
  const name = slice.name?.trim() || `#${slice.branch_id}`;
  const label = branchTitle(slice.name, `Filial #${slice.branch_id}`);
  const auto = snapshot.close_reason === 'auto';
  const totals = sliceTotals(slice);
  const workbook = createReport(`${name} — HQ'ga topshirilgan`);
  const ws = addReportSheet(workbook, "HQ'ga topshirilgan", SLIP_WIDTHS, {
    tab: C.action,
    footer: `${label} · Asosiy kassa smenasi #${snapshot.shift_id}`,
  });
  let r = addShiftBanner(ws, {
    title: "HQ'ga topshirilgan pul",
    subtitle: `${label} · Asosiy kassa smenasi #${snapshot.shift_id}`,
    right: day(snapshot.closed_at),
    rightSub: auto ? 'Smena avtomatik yopilgan' : 'Smena yopilgan',
  });
  r = addMetaAt(
    ws,
    r,
    [
      { label: 'Filial', value: name },
      { label: 'Asosiy kassa smenasi', value: `#${snapshot.shift_id}` },
      {
        label: 'Yopilgan',
        value: dateCell(snapshot.closed_at),
        fmt: F.dateTime,
      },
      { label: "To'lovlar soni", value: totals.count, fmt: F.count },
    ],
    SLIP_META,
  );
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 4],
      label: "Jami topshirilgan, so'm",
      value: totals.net,
      tone: 'success',
      sub: 'Qaytarilgani ayirilgan',
      size: 16,
    },
    {
      at: [5, 6],
      label: "Qaytarilgan, so'm",
      value: totals.reversed,
      ...(totals.reversed ? { tone: 'danger' as const } : {}),
      sub: totals.reversed ? 'Jamidan ayirilgan' : "Qaytarish yo'q",
      size: 16,
    },
    {
      at: [7, 8],
      label: "Filial kassasidagi qoldiq, so'm",
      ...balanceKpi(slice.balance),
      sub: 'Hisobot vaqtida',
      size: 16,
    },
  ]);
  r = addSection(ws, r, "Topshirilgan to'lovlar", `${totals.count} ta`);
  const table = addTable(ws, r, {
    zebra: false,
    rowHeight: 20,
    rows: slipRows(slice.payments),
    columns: slipColumns(false),
    rowTone: (row) => (row.reversed ? 'danger' : undefined),
    empty: "Bu smenada HQ'ga pul topshirilmagan",
  });
  const end = addSlipTotals(ws, slice, totals, table, {
    total: 'Jami topshirilgan',
    balance: 'Filial kassasidagi qoldiq',
  });
  linkCell(ws, kpiRow + 1, 2, end.net, totals.net);
  r = end.next;
  if (totals.reversed) {
    r = addNote(
      ws,
      r,
      "«Qaytarildi» — shu smenada qaytarilgan to'lov, manfiy summa bilan ko'rsatiladi va jamidan ayiriladi.",
      'info',
    );
  }
  addSignatures(ws, r, ['Topshirdi (filial)', 'Qabul qildi (asosiy kassa)']);
  return reportToBuffer(workbook);
}

/**
 * Market Excel'i — FAQAT o'z to'lovlari (`slice`): smena, yopilgan vaqt,
 * har to'lov (summa, usul, karta, vaqt, izoh), jami va qoldiq.
 */
export async function buildMarketXlsx(
  snapshot: ClosedShift,
  slice: MarketSlice,
): Promise<Buffer> {
  const name = slice.name?.trim() || `#${slice.market_id}`;
  const totals = sliceTotals(slice);
  const workbook = createReport(`${name} — to'lovlar`);
  const ws = addReportSheet(workbook, "To'lovlar", SLIP_WIDTHS, {
    tab: C.action,
    footer: `${name} · Smena #${snapshot.shift_id}`,
  });
  let r = addShiftBanner(ws, {
    title: "To'lovlar hisoboti",
    subtitle: `${name} · Elchi Pochta smenasi #${snapshot.shift_id}`,
    right: day(snapshot.closed_at),
    rightSub: 'Smena yopilgan',
  });
  r = addMetaAt(
    ws,
    r,
    [
      { label: 'Market', value: name },
      { label: 'Smena', value: `#${snapshot.shift_id}` },
      {
        label: 'Yopilgan',
        value: dateCell(snapshot.closed_at),
        fmt: F.dateTime,
      },
      { label: "To'lovlar soni", value: totals.count, fmt: F.count },
    ],
    SLIP_META,
  );
  const kpiRow = r;
  r = addKpisAt(ws, r, [
    {
      at: [2, 5],
      label: "Sizga to'langan, so'm",
      value: totals.net,
      tone: 'success',
      sub: totals.reversed
        ? 'Qaytarilgani ayirilgan'
        : `${totals.count} ta to'lov`,
      size: 18,
    },
    {
      at: [6, 8],
      label: "Hisobingizdagi qoldiq, so'm",
      ...balanceKpi(slice.balance),
      sub: 'Hisobot vaqtida',
      size: 18,
    },
  ]);
  r = addSection(ws, r, "Sizga qilingan to'lovlar", `${totals.count} ta`);
  const table = addTable(ws, r, {
    zebra: false,
    rowHeight: 20,
    rows: slipRows(slice.payments),
    columns: slipColumns(true),
    rowTone: (row) => (row.reversed ? 'danger' : undefined),
    empty: "Bu smenada to'lov qilinmagan",
  });
  // Uzun karta nomi kesilmasin.
  for (let k = table.first; k <= table.last; k += 1) {
    const cell = ws.getCell(k, 7);
    cell.alignment = { ...cell.alignment, shrinkToFit: true };
  }
  const end = addSlipTotals(ws, slice, totals, table, {
    total: "Jami to'langan",
    balance: 'Hisobingizdagi qoldiq',
  });
  linkCell(ws, kpiRow + 1, 2, end.net, totals.net);
  const notes = [
    ...(slice.balance != null
      ? [
          slice.balance < 0
            ? "Manfiy qoldiq — sizga ortiqcha to'langan summa (hisobot vaqtida)."
            : "Qoldiq — hisobingizda turgan, hali to'lanmagan summa (hisobot vaqtida).",
        ]
      : []),
    ...(totals.reversed
      ? [
          "Qaytarildi — qaytarilgan to'lov: manfiy summa bilan ko'rsatiladi va jamidan ayiriladi.",
        ]
      : []),
  ];
  if (notes.length) {
    addNote(ws, end.next, notes.join('\n'), 'neutral', notes.length);
  }
  return reportToBuffer(workbook);
}
