/**
 * Carrier API kassa ko'rinishi (`GET /carrier/cashbox`).
 *
 * ⚠️ NEGA XOM FINANCE JAVOBI QAYTARILMAYDI. `finance.cashbox.my` tarix
 * qatorlariga `created_by_user` / `source_user` (Elchi xodimining ismi va
 * TELEFONI), dedup tokenlari, karta id'lari va isbot fayl kalitlarini
 * qo'shadi. Ular tashqi kompaniyaga tegishli emas. Bu yerda aniq ro'yxat
 * (allowlist) — yangi ichki maydon tashqariga o'z-o'zidan chiqmaydi.
 *
 * Kontrakt: docs/public/CARRIER_API.md §5.4.
 */
export type CarrierCashboxEntry = {
  id: string;
  /** `income` — kassaga kirim, `expense` — chiqim. */
  type: string;
  /** Harakat manbai: `sell`, `cancel`, `correction`, `courier_payment`, … */
  source_type: string;
  amount: number;
  balance_after: number;
  /** Buyurtma bilan bog'liq qatorda — buyurtma id, aks holda null. */
  order_id: string | null;
  payment_method: string | null;
  comment: string | null;
  created_at: string | null;
};

export type CarrierCashboxView = {
  /** Joriy balans — siz Elchi'ga topshirishingiz kerak bo'lgan summa. */
  balance: number;
  /** Tanlangan davrdagi jami kirim. */
  income: number;
  /** Tanlangan davrdagi jami chiqim. */
  outcome: number;
  history: CarrierCashboxEntry[];
};

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
};

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bu manbalarda `source_id` — buyurtma id (order-service sotuv/bekor/
 * qo'shimcha xarajat/tuzatish oyoqlari `source_id: String(order.id)` yozadi).
 * Boshqa manbalarda (`courier_payment` va h.k.) u o'tkazma tokeni —
 * tashqariga chiqmaydi.
 */
const ORDER_SOURCE_TYPES = new Set([
  'sell',
  'cancel',
  'extra_cost',
  'correction',
]);

function toEntry(row: Row): CarrierCashboxEntry {
  const sourceType = str(row.source_type) ?? '';
  const sourceId = str(row.source_id);
  const createdAt = row.createdAt ?? row.created_at;
  return {
    id: str(row.id) ?? '',
    type: str(row.operation_type) ?? '',
    source_type: sourceType,
    amount: num(row.amount),
    balance_after: num(row.balance_after),
    order_id:
      ORDER_SOURCE_TYPES.has(sourceType) && sourceId && /^\d+$/.test(sourceId)
        ? sourceId
        : null,
    payment_method: str(row.payment_method),
    comment: str(row.comment),
    created_at:
      createdAt instanceof Date ? createdAt.toISOString() : str(createdAt),
  };
}

/** `finance.cashbox.my` javobi (`{ statusCode, data: { cashbox, cashboxHistory, income, outcome } }`). */
export function toCarrierCashboxView(response: unknown): CarrierCashboxView {
  const envelope = isRow(response) ? response : {};
  const data = isRow(envelope.data) ? envelope.data : envelope;
  const cashbox = isRow(data.cashbox) ? data.cashbox : {};
  const history = Array.isArray(data.cashboxHistory)
    ? data.cashboxHistory.filter(isRow)
    : [];
  return {
    balance: num(cashbox.balance),
    income: num(data.income),
    outcome: num(data.outcome),
    history: history.map(toEntry),
  };
}
