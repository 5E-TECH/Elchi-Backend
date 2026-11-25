import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  addBanner,
  addReportSheet,
  addTable,
  createReport,
  formula,
  reportFont,
  reportToBuffer,
  toExcelDate,
} from '@app/report-kit';
import {
  MAIN_CASHBOX_NAME,
  asText,
  branchLabel,
  cashboxSourceLabel,
  dateText,
  dateTimeText,
  numberOrNull,
  paymentMethodLabel,
  periodText,
  round2,
  sumBy,
  textOrNull,
  toAmount,
} from './report-labels';
import {
  addDivider,
  addKpisAt,
  balanceCheck,
  checkFormula,
  formulaIf,
  printTitles,
  textFormula,
  wrapColumn,
} from './report-parts';

/** Karta ko'chirmasi (B4) — `GET finance/cashbox/cards/:id/ledger/export`. */
export interface CardLedgerReportInput {
  /** `finance.cashbox.cards.ledger` javobining `data` si. */
  data: Record<string, unknown>;
  from_date?: string;
  to_date?: string;
  cardNames: ReadonlyMap<string, string>;
  userNames: ReadonlyMap<string, string>;
  branchNames: ReadonlyMap<string, string>;
  now?: Date;
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  income: 'Kirim',
  expense: 'Chiqim',
  transfer_in: "Kartaga o'tkazma",
  transfer_out: "Kartadan o'tkazma",
  cash_to_card: 'Naqddan kartaga',
  card_to_cash: 'Kartadan naqdga',
};
const CARD_KIND_LABEL: Readonly<Record<string, string>> = {
  virtual_card: 'Virtual karta',
  plastic_card: 'Plastik karta',
  bank_account: 'Hisob raqam',
};

interface LedgerRow {
  opening?: true;
  n: number | null;
  date: Date | null;
  kind: string;
  income: boolean;
  amount: number;
  balance: number;
  source: string | null;
  method: string | null;
  card: string | null;
  comment: string | null;
  who: string | null;
}

/** Karta haqida bitta qator: nomi · tizim •••• raqam · turi · bank · egasi. */
const cardLine = (card: Record<string, unknown>): string => {
  const kind = asText(card.kind);
  const network = textOrNull(card.card_network);
  const last4 = textOrNull(card.last4);
  const number = [
    network ? network.charAt(0).toUpperCase() + network.slice(1) : null,
    last4 ? `•••• ${last4}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const holder = textOrNull(card.holder_name);
  return [
    textOrNull(card.name),
    number,
    CARD_KIND_LABEL[kind] ?? kind,
    textOrNull(card.bank_name),
    holder ? `Egasi: ${holder}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

export function buildCardLedgerReport(
  input: CardLedgerReportInput,
): Promise<Buffer> {
  const now = input.now ?? new Date();
  const { data } = input;
  const card = (data.card ?? {}) as Record<string, unknown>;
  const summary = (data.summary ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(data.items)
    ? (data.items as Array<Record<string, unknown>>)
    : [];
  const isBranch = data.cashbox_type === 'branch';

  // Finance eng yangisini tepada beradi — ko'chirma eskidan yangiga.
  const rows = [...rawItems].reverse().map((raw, i): LedgerRow => {
    const delta = toAmount(raw.delta);
    const source = asText(raw.source_type);
    const method = asText(raw.payment_method);
    const cardId = asText(raw.counterparty_card_id);
    const createdBy = asText(raw.created_by);
    const kind = asText(raw.kind);
    return {
      n: i + 1,
      date: toExcelDate(raw.created_at),
      kind: KIND_LABEL[kind] ?? kind,
      income: delta >= 0,
      amount: Math.abs(delta),
      balance: toAmount(raw.balance_after),
      source: source
        ? cashboxSourceLabel(source, method, isBranch ? 'branch' : 'main')
        : null,
      method: method ? paymentMethodLabel(method) : null,
      card: cardId ? (input.cardNames.get(cardId) ?? `#${cardId}`) : null,
      comment: textOrNull(raw.comment),
      who: createdBy
        ? (input.userNames.get(createdBy) ?? `#${createdBy}`)
        : null,
    };
  });
  const n = rows.length;
  const income = sumBy(rows, (row) => (row.income ? row.amount : 0));
  const expense = sumBy(rows, (row) => (row.income ? 0 : row.amount));
  const incomeCount = rows.filter((row) => row.income).length;
  const opening =
    numberOrNull(summary.opening_balance) ??
    (n
      ? round2(rows[0].balance - (rows[0].income ? 1 : -1) * rows[0].amount)
      : 0);
  const closing =
    numberOrNull(summary.closing_balance) ??
    (n ? rows[n - 1].balance : opening);
  const current =
    numberOrNull(summary.current_balance) ?? numberOrNull(card.balance);

  const workbook = createReport("Karta ko'chirmasi", now);
  // B № | C Sana | D Amal | E Kirim | F Chiqim | G Qoldiq | H Manba |
  // I To'lov usuli | J Qarshi karta | K Izoh | L Kiritgan
  const ws = addReportSheet(
    workbook,
    'Harakatlar',
    [5, 16, 20, 15, 15, 15, 25, 18, 16, 37, 18],
    { orientation: 'landscape', freeze: 10, footer: "Karta ko'chirmasi" },
  );
  let r = addBanner(ws, {
    title: "Karta ko'chirmasi",
    subtitle: cardLine(card),
    right: periodText(input.from_date, input.to_date),
    rightSub: isBranch
      ? branchLabel(data.branch_id, input.branchNames)
      : MAIN_CASHBOX_NAME,
  });
  const head = r + 4;
  const openRow = head + 1; // «Davr boshida» qatori
  const R1 = openRow + 1;
  const R2 = openRow + n;
  const range = (c: string) => `${c}${R1}:${c}${R2}`;
  const okText = 'Mos keldi: davr boshi + kirim − chiqim';
  const check = balanceCheck(opening + income - expense, closing, okText);
  r = addKpisAt(ws, r, [
    {
      from: 2,
      to: 4,
      label: "Hozirgi qoldiq, so'm",
      value: current ?? '—',
      tone: 'action',
      sub: `${dateTimeText(now)} holatiga`,
    },
    {
      from: 5,
      to: 6,
      label: "Davr boshida, so'm",
      value: formula(`G${openRow}`, opening),
      sub: dateText(input.from_date),
    },
    {
      from: 7,
      to: 8,
      label: "Kirim, so'm",
      value: formulaIf(n > 0, `SUM(${range('E')})`, income),
      tone: 'success',
      sub: n
        ? textFormula(
            `COUNT(${range('E')})&" ta harakat"`,
            `${incomeCount} ta harakat`,
          )
        : '0 ta harakat',
    },
    {
      from: 9,
      to: 10,
      label: "Chiqim, so'm",
      value: formulaIf(n > 0, `SUM(${range('F')})`, expense),
      tone: 'danger',
      sub: n
        ? textFormula(
            `COUNT(${range('F')})&" ta harakat"`,
            `${n - incomeCount} ta harakat`,
          )
        : '0 ta harakat',
    },
    {
      from: 11,
      to: 12,
      label: "Davr oxirida, so'm",
      value: n > 0 ? formula(`G${R2}`, closing) : closing,
      tone: check.ok ? undefined : 'warning',
      sub: n
        ? checkFormula(
            `G${openRow}+SUM(${range('E')})-SUM(${range('F')})`,
            `G${R2}`,
            okText,
            check,
          )
        : check.text,
      subTone: check.ok ? undefined : 'warning',
    },
  ]);
  ws.getRow(r - 1).height = 8;

  const openingRow: LedgerRow = {
    opening: true,
    n: null,
    date: toExcelDate(input.from_date),
    kind: 'Davr boshida',
    income: true,
    amount: 0,
    balance: opening,
    source: null,
    method: null,
    card: null,
    comment: null,
    who: null,
  };
  const table = addTable(ws, r, {
    total: true,
    filter: true,
    rows: [openingRow, ...rows],
    rowTone: (x) => (x.opening ? 'neutral' : undefined),
    columns: [
      { header: '№', align: 'center', value: (x) => x.n },
      { header: 'Sana', fmt: F.dateTime, value: (x) => x.date },
      {
        header: 'Amal',
        tone: (x) => (x.opening ? undefined : x.income ? 'success' : 'danger'),
        value: (x) => x.kind,
      },
      {
        header: "Kirim, so'm",
        fmt: F.som,
        color: C.success,
        sum: true,
        value: (x) => (!x.opening && x.income ? x.amount : null),
      },
      {
        header: "Chiqim, so'm",
        fmt: F.som,
        color: C.danger,
        sum: true,
        value: (x) => (!x.opening && !x.income ? x.amount : null),
      },
      {
        header: "Qoldiq, so'm",
        fmt: F.som,
        bold: true,
        value: (x) => x.balance,
        totalValue: formula(
          `G${openRow}+E${R2 + 1}-F${R2 + 1}`,
          round2(opening + income - expense),
        ),
      },
      { header: 'Manba', value: (x) => x.source },
      { header: "To'lov usuli", value: (x) => x.method },
      { header: 'Qarshi karta', value: (x) => x.card },
      { header: 'Izoh', value: (x) => x.comment },
      { header: 'Kiritgan', value: (x) => x.who },
    ],
  });
  wrapColumn(ws, table, 9);
  // Boshlang'ich qoldiq qatori — faqat sana, yorliq qalin.
  ws.getCell(table.first, 3).numFmt = F.date;
  ws.getCell(table.first, 4).font = reportFont({ bold: true, color: C.muted });
  for (const c of [4, 7]) addDivider(ws, table, c);
  printTitles(ws, table.header);
  return reportToBuffer(workbook);
}
