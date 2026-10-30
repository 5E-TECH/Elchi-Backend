import type { EntityManager } from 'typeorm';
import {
  CASHBOX_RECEIPT_AI_MAX_ATTEMPTS,
  CASHBOX_RECEIPT_FILTER_STATUSES,
  isReceiptAiStale,
  receiptReanalyzeBlock,
  receiptSettingGroupOf,
  type CashboxReceiptFilterStatus,
  type CashboxReceiptKind,
  type CashboxReceiptSettings,
} from '@app/common';

/**
 * T3 (QlLf33Ma) — kassa tarixidagi chek: ro'yxatda qisqa `{ id, ai_status }`,
 * tafsilotda to'liq; «Chek holati» filtri va «Chek yo'q» predikati (T3-4
 * summary ham AYNI predikatni ishlatadi).
 *
 * Jadval yo'llari chaqiruvchidan (TypeORM metadata) — sxema sozlamasiga
 * bog'liq emas.
 */
export interface ReceiptTables {
  receipts: string;
  history: string;
  cashbox: string;
}

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part.replace(/"/g, '')}"`)
    .join('.');

export const isReceiptFilterStatus = (
  value: unknown,
): value is CashboxReceiptFilterStatus =>
  typeof value === 'string' &&
  (CASHBOX_RECEIPT_FILTER_STATUSES as readonly string[]).includes(value);

/**
 * «Chek yo'q» — chek SO'RALADIGAN, lekin cheksiz qator (ega qarori):
 *  (a) qo'lda chiqim: `manual_expense` + EXPENSE + `expense_category_id IS
 *      NOT NULL` (ichki chiqimlar kategoriyasiz — kirmaydi);
 *  (b) HQ'ga o'tkazma: MAIN INCOME, `courier_payment | branch_to_main`,
 *      `click`.
 * Naqd o'tkazma, click_to_market, kirim, maosh, sotuv, qarshi EXPENSE
 * qatorlar va T6 bilan qaytarilgan oyoqlar (`notReversedSql`) kirmaydi. Funksiyadan oldingi va rasm o'chiq paytdagilar ham
 * shu predikat bilan `none`. `h` — tarix alias'i, `c` — kassa alias'i.
 */
export const RECEIPT_EXPECTED_SQL = `(
  (h."operation_type" = 'expense' AND h."source_type" = 'manual_expense'
    AND h."expense_category_id" IS NOT NULL)
  OR (h."operation_type" = 'income'
    AND h."source_type" IN ('courier_payment', 'branch_to_main')
    AND h."payment_method" = 'click' AND c."cashbox_type" = 'main')
)`;

/**
 * T6 — qaytarilgan (`payment_reversal` bilan yopilgan) oyoq «Chek yo'q» va
 * xulosaga kirmaydi: tuzatishdan keyin to'lov yangi (replacement) oyoqda.
 */
export function notReversedSql(historyTable: string, alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM ${historyTable} rv
      WHERE rv."reverses_history_id" = ${alias}."id" AND rv."is_deleted" = false)`;
}

/** Bog'langan chekning tarix qatorlari (asosiy va qarshi oyoq). */
function linkedIdsSql(tables: ReceiptTables, statusParam?: string): string {
  const r = quote(tables.receipts);
  const status = statusParam ? ` AND r."ai_status" = :${statusParam}` : '';
  return `SELECT r."history_id" FROM ${r} r
      WHERE r."is_deleted" = false AND r."state" = 'linked'${status}
    UNION ALL
    SELECT r."counter_history_id" FROM ${r} r
      WHERE r."is_deleted" = false AND r."state" = 'linked'
        AND r."counter_history_id" IS NOT NULL${status}`;
}

/**
 * Tarix `id` ustuni uchun shart (TypeORM `Raw`): `alias IN (...)`.
 * `none` — kutilgan, lekin bog'lanmagan asosiy qator.
 */
export function receiptStatusIdCondition(
  alias: string,
  status: CashboxReceiptFilterStatus,
  tables: ReceiptTables,
): { sql: string; params: Record<string, unknown> } {
  if (status === 'none') {
    const h = quote(tables.history);
    const c = quote(tables.cashbox);
    return {
      sql: `${alias} IN (SELECT h."id" FROM ${h} h
          JOIN ${c} c ON c."id" = h."cashbox_id"
          WHERE h."is_deleted" = false AND ${RECEIPT_EXPECTED_SQL}
            AND ${notReversedSql(h, 'h')})
        AND ${alias} NOT IN (${linkedIdsSql(tables)})`,
      params: {},
    };
  }
  return {
    sql: `${alias} IN (${linkedIdsSql(tables, 'receiptStatus')})`,
    params: { receiptStatus: status },
  };
}

interface ReceiptRow {
  id: string;
  kind: CashboxReceiptKind;
  state: string;
  history_id: string | null;
  counter_history_id: string | null;
  branch_id: string | null;
  courier_id: string | null;
  card_id: string | null;
  entered_amount: string | number | null;
  payment_method: string | null;
  file_key: string;
  uploaded_by: string;
  uploaded_at: Date;
  linked_at: Date | null;
  ai_status: string;
  ai_requested_at: Date | null;
  ai_attempts: number;
  ai_error_reason: string | null;
  ai_amount: string | number | null;
  ai_difference: string | number | null;
  ai_currency: string | null;
  ai_date: string | null;
  ai_recipient: string | null;
  ai_recipient_last4: string | null;
  ai_payer: string | null;
  ai_payer_last4: string | null;
  ai_bank: string | null;
  ai_reference: string | null;
  ai_confidence: string | number | null;
  ai_flags: unknown;
  ai_checked_at: Date | null;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Qatorlar → `history_id | counter_history_id` bo'yicha cheklar (bitta so'rov). */
export async function loadReceiptsForHistory(
  manager: EntityManager,
  tablePath: string,
  historyIds: string[],
): Promise<Map<string, ReceiptRow>> {
  const ids = Array.from(
    new Set(historyIds.map(String).filter((id) => /^\d+$/.test(id))),
  );
  const map = new Map<string, ReceiptRow>();
  if (!ids.length) return map;
  const rows: ReceiptRow[] = await manager.query(
    `SELECT * FROM ${quote(tablePath)}
      WHERE "is_deleted" = false AND "state" = 'linked'
        AND ("history_id" = ANY($1::bigint[])
          OR "counter_history_id" = ANY($1::bigint[]))`,
    [ids],
  );
  for (const row of rows) {
    if (row.history_id) map.set(String(row.history_id), row);
    if (row.counter_history_id) map.set(String(row.counter_history_id), row);
  }
  return map;
}

export function briefReceipt(row: ReceiptRow | undefined) {
  return row ? { id: String(row.id), ai_status: row.ai_status } : null;
}

/**
 * To'liq ko'rinish (tafsilot, `GET /finance/receipts/:id`). `file_key` —
 * gateway uni imzolangan havolaga almashtiradi (FE'ga kalit chiqmaydi).
 * `can_reanalyze` — FAQAT qoida (rol — gateway'da).
 */
export function fullReceipt(
  row: ReceiptRow,
  settings: CashboxReceiptSettings,
  names: Map<string, string | null>,
  now: number = Date.now(),
) {
  const group = settings[receiptSettingGroupOf(row.kind)];
  const aiOn = group.photo_required && group.ai_enabled;
  const block = receiptReanalyzeBlock(row, aiOn, now);
  const checked = !['pending', 'disabled'].includes(row.ai_status);
  return {
    id: String(row.id),
    kind: row.kind,
    state: row.state,
    history_id: row.history_id ? String(row.history_id) : null,
    counter_history_id: row.counter_history_id
      ? String(row.counter_history_id)
      : null,
    branch_id: row.branch_id ? String(row.branch_id) : null,
    courier_id: row.courier_id ? String(row.courier_id) : null,
    entered_amount: num(row.entered_amount),
    payment_method: row.payment_method,
    file_key: row.file_key,
    uploaded_by: {
      id: String(row.uploaded_by),
      name: names.get(String(row.uploaded_by)) ?? null,
    },
    uploaded_at: row.uploaded_at,
    linked_at: row.linked_at,
    ai_status: row.ai_status,
    ai_stale: isReceiptAiStale(row, now),
    can_reanalyze: block === null,
    reanalyze_block: block,
    ai:
      checked || row.ai_attempts > 0
        ? {
            amount: num(row.ai_amount),
            difference: num(row.ai_difference),
            currency: row.ai_currency,
            date: row.ai_date,
            recipient: row.ai_recipient,
            recipient_last4: row.ai_recipient_last4,
            payer: row.ai_payer,
            payer_last4: row.ai_payer_last4,
            bank: row.ai_bank,
            reference: row.ai_reference,
            confidence: num(row.ai_confidence),
            flags: Array.isArray(row.ai_flags) ? row.ai_flags : [],
            checked_at: row.ai_checked_at,
            attempts: Number(row.ai_attempts ?? 0),
            max_attempts: CASHBOX_RECEIPT_AI_MAX_ATTEMPTS,
            error_reason: row.ai_error_reason,
          }
        : null,
  };
}

export type FullReceiptView = ReturnType<typeof fullReceipt>;
