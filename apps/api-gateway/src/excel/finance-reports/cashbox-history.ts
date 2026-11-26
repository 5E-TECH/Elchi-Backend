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
  /** (2026-11-26) Yo'nalish — `include_route` bilan so'ralganda; aks holda `null`. */
  route: HistoryRouteView | null;
  /** T6 tuzatish holati (asl / teskari / yangi qator); tuzatilmagan — `null`. */
  correction: HistoryCorrectionView | null;
}

export interface HistoryRouteParty {
  id: string;
  name: string | null;
}

/** finance `route` (kimdan → kimga). */
export interface HistoryRouteView {
  variant: string;
  cashboxType: string;
  branchId: string | null;
  courier: HistoryRouteParty | null;
  market: HistoryRouteParty | null;
}

/** finance `correction` (T6). */
export interface HistoryCorrectionView {
  role: string;
  action: string;
  relatedId: string | null;
  reason: string | null;
}

const nameOf = (value: unknown): string | null =>
  textOrNull((value as { name?: unknown } | null | undefined)?.name);

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const partyOf = (value: unknown): HistoryRouteParty | null => {
  const raw = recordOf(value);
  const id = raw ? asText(raw.id).trim() : '';
  return id ? { id, name: nameOf(raw) } : null;
};

const routeOf = (value: unknown): HistoryRouteView | null => {
  const raw = recordOf(value);
  const variant = raw ? asText(raw.variant).trim() : '';
  if (!raw || !variant) return null;
  return {
    variant,
    cashboxType: asText(raw.cashbox_type),
    branchId: textOrNull(raw.branch_id),
    courier: partyOf(raw.courier),
    market: partyOf(raw.market),
  };
};

const correctionOf = (value: unknown): HistoryCorrectionView | null => {
  const raw = recordOf(value);
  const role = raw ? asText(raw.role).trim() : '';
  if (!raw || !role) return null;
  return {
    role,
    action: asText(raw.action),
    relatedId: textOrNull(raw.related_history_id),
    reason: textOrNull(raw.reason),
  };
};

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
    route: routeOf(raw.route),
    correction: correctionOf(raw.correction),
  };
};

/**
 * (2026-11-26, ega) «Yo'nalish» — kimdan → kimga (qator qaysi kassada
 * bo'lmasin, butun to'lov): «Kuryer Ali → Urgut filiali kassasi», «Asosiy
 * kassa → Baraka Shop», «Kuryer Ali → Baraka Shop (o'tkazma, Urgut filiali
 * menejeri yozgan)». Yo'nalish noma'lum — `null`.
 */
export const routeText = (
  row: Pick<HistoryRow, 'route'>,
  branchNames: ReadonlyMap<string, string>,
): string | null => {
  const route = row.route;
  if (!route) return null;
  const branch = branchLabel(route.branchId, branchNames);
  const courier = route.courier
    ? `Kuryer ${route.courier.name ?? `#${route.courier.id}`}`
    : 'Kuryer';
  const market = route.market
    ? (route.market.name ?? `Market #${route.market.id}`)
    : 'Market';
  switch (route.variant) {
    case 'courier':
      return `${courier} → ${route.cashboxType === 'branch' ? `${branch} kassasi` : MAIN_CASHBOX_NAME}`;
    case 'courier_click':
      return `${courier} → ${market} (o'tkazma, HQ yozgan)`;
    case 'courier_click_branch':
      return `${courier} → ${market} (o'tkazma, ${branch} menejeri yozgan)`;
    case 'market':
      return `${MAIN_CASHBOX_NAME} → ${market}`;
    case 'market_branch':
      return `${branch} kassasi → ${market}`;
    case 'branch_click_market':
      return `${branch} → ${market} (o'tkazma, HQ yozgan)`;
    default:
      return null;
  }
};

/**
 * (2026-11-26) T6 holati: asl to'lov — «Qaytarilgan» / «Tahrirlangan»;
 * teskari qator — «Qaytarish (#asl)»; tahrirdagi yangi qator — «Tuzatilgan
 * (#asl o'rniga)». Tuzatilmagan — `null`.
 */
export const correctionStatus = (
  row: Pick<HistoryRow, 'correction'>,
): string | null => {
  const c = row.correction;
  if (!c) return null;
  if (c.role === 'reversal') {
    return c.relatedId ? `Qaytarish (#${c.relatedId})` : 'Qaytarish';
  }
  if (c.role === 'replacement') {
    return c.relatedId ? `Tuzatilgan (#${c.relatedId} o'rniga)` : 'Tuzatilgan';
  }
  if (c.role === 'original') {
    return c.action === 'edit' ? 'Tahrirlangan' : 'Qaytarilgan';
  }
  return null;
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
