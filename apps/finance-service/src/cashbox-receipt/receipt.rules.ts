import type { CashboxReceiptAiStatus } from '@app/common';

/**
 * T3-3 (QlLf33Ma) — chek AI natijasidan holat va bayroqlar. SOF funksiyalar
 * (DB yo'q) — unit test bilan qotirilgan.
 *
 * HOLAT:
 *  - AI xatosi: `refused | invalid_json | truncated` → `unreadable`
 *    (rasm o'qilmaydi), boshqasi (tarmoq, timeout, limit, o'chiq) → `error`;
 *  - summa yo'q yoki ishonch < 0,5 → `unreadable`;
 *  - `difference = o'qilgan − kiritilgan`; |difference| ≤ 1 so'm va valyuta
 *    UZS (yoki ko'rsatilmagan — mahalliy chek) → `match`, aks holda
 *    `mismatch`.
 * BAYROQLAR holatni o'zgartirmaydi (faqat ogohlantirish).
 */
export const RECEIPT_AI_MIN_CONFIDENCE = 0.5;
export const RECEIPT_MATCH_TOLERANCE = 1;
export const RECEIPT_DATE_FAR_DAYS = 3;
export const RECEIPT_DUPLICATE_REFERENCE_DAYS = 90;
const UNREADABLE_REASONS = new Set(['refused', 'invalid_json', 'truncated']);

export type ReceiptAiFlag =
  'duplicate_photo' | 'duplicate_reference' | 'date_far' | 'card_mismatch';

export interface ReceiptAiResult {
  ok?: unknown;
  reason?: unknown;
  amount?: unknown;
  currency?: unknown;
  confidence?: unknown;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function deriveReceiptOutcome(
  result: ReceiptAiResult | null | undefined,
  enteredAmount: number | null,
): {
  status: Exclude<CashboxReceiptAiStatus, 'pending' | 'disabled'>;
  difference: number | null;
  error_reason: string | null;
} {
  if (!result || result.ok !== true) {
    const reason = typeof result?.reason === 'string' ? result.reason : 'error';
    return {
      status: UNREADABLE_REASONS.has(reason) ? 'unreadable' : 'error',
      difference: null,
      error_reason: reason.slice(0, 64),
    };
  }
  const amount = finite(result.amount);
  const confidence = finite(result.confidence);
  if (amount === null) {
    return {
      status: 'unreadable',
      difference: null,
      error_reason: 'no_amount',
    };
  }
  if (confidence === null || confidence < RECEIPT_AI_MIN_CONFIDENCE) {
    return {
      status: 'unreadable',
      difference: null,
      error_reason: 'low_confidence',
    };
  }
  const entered = finite(enteredAmount);
  if (entered === null) {
    return {
      status: 'unreadable',
      difference: null,
      error_reason: 'no_entered',
    };
  }
  const difference = round2(amount - entered);
  const currency =
    typeof result.currency === 'string' ? result.currency.toUpperCase() : null;
  const sameCurrency = currency === null || currency === 'UZS';
  return {
    status:
      sameCurrency && Math.abs(difference) <= RECEIPT_MATCH_TOLERANCE
        ? 'match'
        : 'mismatch',
    difference,
    error_reason: null,
  };
}

/**
 * Chekdagi sana matni → Date (Toshkent). Qo'llab-quvvatlanadi:
 * `dd.mm.yyyy` / `dd/mm/yyyy` / `dd-mm-yyyy` (vaqt bilan ham), `yyyy-mm-dd`.
 * Tushunarsiz — null (bayroq qo'yilmaydi).
 */
export function parseReceiptDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const dmy = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(text);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy) {
    [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Toshkent kuni o'rtasi (UTC+5) — vaqt mintaqasi siljishi bayroqqa ta'sir qilmasin.
  const ms = Date.UTC(year, month - 1, day, 7, 0, 0);
  const date = new Date(ms);
  return date.getUTCMonth() === month - 1 ? date : null;
}

export function deriveReceiptFlags(input: {
  duplicate_photo: boolean;
  duplicate_reference: boolean;
  receipt_date: unknown;
  operation_at: Date | null;
  /** Kutilgan karta oxirgi 4 raqami(lar)i; bo'sh — tekshirilmaydi. */
  expected_last4: string[];
  /** O'tkazmada — oluvchi, chiqimda — to'lovchi kartasi (AI o'qigan). */
  detected_last4: string | null;
}): ReceiptAiFlag[] {
  const flags: ReceiptAiFlag[] = [];
  if (input.duplicate_photo) flags.push('duplicate_photo');
  if (input.duplicate_reference) flags.push('duplicate_reference');
  const date = parseReceiptDate(input.receipt_date);
  if (
    date &&
    input.operation_at &&
    Math.abs(date.getTime() - input.operation_at.getTime()) >
      RECEIPT_DATE_FAR_DAYS * 86_400_000 + 12 * 3_600_000
  ) {
    flags.push('date_far');
  }
  const expected = input.expected_last4.filter((v) => /^\d{4}$/.test(v));
  if (
    expected.length &&
    input.detected_last4 &&
    !expected.includes(input.detected_last4)
  ) {
    flags.push('card_mismatch');
  }
  return flags;
}
