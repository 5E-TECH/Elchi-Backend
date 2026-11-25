import {
  asText,
  cashboxSourceLabel,
  cashboxTypeLabel,
  MAIN_CASHBOX_NAME,
  branchLabel,
  numberOrNull,
  round2,
  sameMoney,
  textOrNull,
  timeOf,
  toAmount,
} from './report-labels';

/**
 * Kassa tarixi (`finance.history.find_all`) qatorlari — B1 va B5/B6 uchun
 * umumiy o'qish: tartib, kassa nomi va qoldiq zanjiri.
 */
export interface HistoryRow {
  id: string;
  createdAt: number;
  /** To'lov sanasi (bo'lmasa yozilgan vaqt). */
  date: unknown;
  income: boolean;
  amount: number;
  source: string;
  sourceId: string;
  sourceUserId: string;
  sourceUserName: string | null;
  method: string;
  cashboxId: string;
  cashboxType: string;
  cashboxOwnerId: string;
  cashboxOwnerName: string | null;
  balance: number | null;
  balanceCash: number | null;
  balanceCard: number | null;
  comment: string | null;
  category: string | null;
  createdBy: string;
  createdByName: string | null;
}

const nameOf = (value: unknown): string | null =>
  textOrNull((value as { name?: unknown } | null | undefined)?.name);

export const toHistoryRow = (raw: Record<string, unknown>): HistoryRow => {
  const cashbox = (raw.cashbox ?? null) as Record<string, unknown> | null;
  return {
    id: asText(raw.id),
    createdAt: timeOf(raw.createdAt ?? raw.created_at),
    date: raw.payment_date ?? raw.createdAt ?? raw.created_at,
    income: raw.operation_type === 'income',
    amount: Math.abs(toAmount(raw.amount)),
    source: asText(raw.source_type),
    sourceId: asText(raw.source_id),
    sourceUserId: asText(raw.source_user_id),
    sourceUserName: nameOf(raw.source_user) ?? nameOf(raw.sourceUser),
    method: asText(raw.payment_method),
    cashboxId: asText(raw.cashbox_id ?? cashbox?.id),
    cashboxType: asText(cashbox?.cashbox_type ?? raw.cashbox_type),
    cashboxOwnerId: asText(cashbox?.user_id),
    cashboxOwnerName: nameOf(cashbox?.user),
    balance: numberOrNull(raw.balance_after),
    balanceCash: numberOrNull(raw.balance_cash_after),
    balanceCard: numberOrNull(raw.balance_card_after),
    comment: textOrNull(raw.comment),
    category: textOrNull(raw.expense_category_name),
    createdBy: asText(raw.created_by),
    createdByName: nameOf(raw.created_by_user) ?? nameOf(raw.createdByUser),
  };
};

const byId = (a: HistoryRow, b: HistoryRow) => Number(a.id) - Number(b.id);

/** Eskidan yangiga (bir lahzada — yozilish tartibi). */
export const sortHistory = (rows: readonly HistoryRow[]): HistoryRow[] =>
  [...rows].sort((a, b) => a.createdAt - b.createdAt || byId(a, b));

export const signedAmount = (row: HistoryRow): number =>
  row.income ? row.amount : -row.amount;

export const isCashMethod = (row: HistoryRow): boolean => row.method === 'cash';

export const historyLabel = (row: HistoryRow): string =>
  cashboxSourceLabel(row.source, row.method, row.cashboxType);

/** Kassa nomi: Asosiy kassa / filial / kuryer / market. */
export const cashboxName = (
  row: HistoryRow,
  branchNames: ReadonlyMap<string, string>,
): string => {
  switch (row.cashboxType) {
    case 'main':
      return MAIN_CASHBOX_NAME;
    case 'branch':
      return branchLabel(row.cashboxOwnerId, branchNames);
    case 'couriers':
      return row.cashboxOwnerName ?? `Kuryer #${row.cashboxOwnerId}`;
    case 'markets':
      return row.cashboxOwnerName ?? `Market #${row.cashboxOwnerId}`;
    default:
      return row.cashboxType ? cashboxTypeLabel(row.cashboxType) : 'Kassa';
  }
};

export interface BalanceChain {
  /** Qatorlar ro'yxatidagi (tartiblangan) o'rni — formulalar shunga qaraydi. */
  firstIndex: number;
  lastIndex: number;
  opening: number;
  closing: number;
  /** Naqd / karta ajratmasi (eski qatorda yo'q bo'lsa — null). */
  split: {
    openingCash: number;
    openingCard: number;
    closingCash: number;
    closingCard: number;
  } | null;
}

/**
 * BITTA kassa qatorlarining qoldiq zanjiri. Birinchi / oxirgi qator — `id`
 * bo'yicha: qator kassa QULFI ostida yoziladi, `createdAt` esa tranzaksiya
 * boshlangan vaqt — bir vaqtdagi amallarda tartibi qoldiq tartibidan farq
 * qilishi mumkin (soxta «Mos kelmadi» chiqmasin).
 */
export const balanceChain = (
  rows: readonly HistoryRow[],
): BalanceChain | null => {
  if (!rows.length) return null;
  let firstIndex = 0;
  let lastIndex = 0;
  rows.forEach((row, i) => {
    if (byId(row, rows[firstIndex]) < 0) firstIndex = i;
    if (byId(row, rows[lastIndex]) > 0) lastIndex = i;
  });
  const first = rows[firstIndex];
  const last = rows[lastIndex];
  if (first.balance === null || last.balance === null) return null;
  const delta = signedAmount(first);
  const cashDelta = isCashMethod(first) ? delta : 0;
  const opening = round2(first.balance - delta);
  const split =
    first.balanceCash === null ||
    first.balanceCard === null ||
    last.balanceCash === null ||
    last.balanceCard === null
      ? null
      : {
          openingCash: round2(first.balanceCash - cashDelta),
          openingCard: round2(first.balanceCard - (delta - cashDelta)),
          closingCash: last.balanceCash,
          closingCard: last.balanceCard,
        };
  return {
    firstIndex,
    lastIndex,
    opening,
    closing: last.balance,
    // Ajratma jamiga teng bo'lmasa (buzilgan eski yozuv) — ko'rsatilmaydi.
    split:
      split &&
      sameMoney(split.openingCash + split.openingCard, opening) &&
      sameMoney(split.closingCash + split.closingCard, last.balance)
        ? split
        : null,
  };
};
