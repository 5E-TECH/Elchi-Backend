/**
 * T3 — `FinanceServiceService` ga `CashboxReceiptService` ni satr tokeni
 * bilan ulash (`SHIFT_ACCOUNT_CHECKS` kabi): eski spec'lar `@app/common` ni
 * mock qiladi — `import type` + token bilan ular servis modulini yuklamaydi.
 */
export const CASHBOX_RECEIPTS = 'FINANCE_CASHBOX_RECEIPTS';

/** Gateway'ning `receipt_policy` + `receipt_id` si (faqat 3 HTTP yo'li). */
export interface ReceiptLinkRequest {
  kind: 'manual_expense' | 'courier_to_hq' | 'branch_to_hq';
  receipt_id?: unknown;
  requester_id?: unknown;
}

/** Javobdagi `data.receipt` (gateway `ai_request_id` ni FE'ga bermaydi). */
export interface LinkedReceiptRef {
  id: string;
  kind: string;
  ai_status: string;
  ai_request_id: string | null;
  /** ICHKI (gateway AI uchun faylni o'qiydi, FE'ga bermaydi). */
  file_key?: string;
  mime?: string;
}
