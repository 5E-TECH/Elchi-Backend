/**
 * T6 — kuryerdan olingan / marketga berilgan pulni QAYTARISH yoki summasini
 * TAHRIRLASH (faqat superadmin). Gateway ↔ finance-service kontrakti:
 * xato kodlari (`PUBLIC_ERROR_CODES` ga ham), sozlama kaliti va chegaralar.
 */

/** Javobdagi `code` (FE matnni emas, kodni tekshiradi). */
export const PAYMENT_CORRECTION_ERROR_CODES = {
  /** 404 — tarix qatori topilmadi. */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 — tur qamrovda emas / teskari qator / kontragent kassasi o'chirilgan. */
  NOT_CORRECTABLE: 'NOT_CORRECTABLE',
  /** 409 — eski yozuv, oyoqlari bog'lanmagan (`transfer_id` NULL). */
  LEGACY_UNLINKED: 'LEGACY_UNLINKED',
  /** 409 — to'lov allaqachon qaytarilgan / tuzatilgan. */
  ALREADY_CORRECTED: 'ALREADY_CORRECTED',
  /** 409 — muddat o'tgan; `deadline` (ISO). */
  WINDOW_EXPIRED: 'WINDOW_EXPIRED',
  /** 400 — asosiy kassada ochiq smena yo'q. */
  SHIFT_REQUIRED: 'SHIFT_REQUIRED',
  /** 400 — filial kassasida ochiq smena yo'q. */
  BRANCH_SHIFT_REQUIRED: 'BRANCH_SHIFT_REQUIRED',
  /** 409 — qabul qiluvchi kassada (yoki kartada) pul yetmaydi. */
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  /** 409 — to'lov kartasi arxivlangan. */
  CARD_ARCHIVED: 'CARD_ARCHIVED',
  /** 409 — yangi summa eskisiga teng. */
  SAME_AMOUNT: 'SAME_AMOUNT',
  /** 409 — yangi summa ruxsat etilganidan katta; `max`. */
  AMOUNT_EXCEEDS: 'AMOUNT_EXCEEDS',
  /** 409 — o'sha `Idempotency-Key` boshqa so'rov bilan ishlatilgan. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** 400 — `Idempotency-Key` sarlavhasi yo'q. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /** 409 — kuryer qaytarilgan / tuzatilgan to'lov kvitansiyasiga javob berdi. */
  PAYMENT_CORRECTED: 'PAYMENT_CORRECTED',
} as const;

export type PaymentCorrectionErrorCode =
  (typeof PAYMENT_CORRECTION_ERROR_CODES)[keyof typeof PAYMENT_CORRECTION_ERROR_CODES];

/** `finance_settings` kaliti (qiymat — butun son, kunlar). */
export const PAYMENT_CORRECTION_WINDOW_KEY = 'payment_correction.window_days';
/** Sozlama qatori yo'q — 30 kun. */
export const PAYMENT_CORRECTION_DEFAULT_WINDOW_DAYS = 30;
export const PAYMENT_CORRECTION_MIN_WINDOW_DAYS = 1;
export const PAYMENT_CORRECTION_MAX_WINDOW_DAYS = 365;

export const PAYMENT_CORRECTION_REASON_MIN = 5;
export const PAYMENT_CORRECTION_REASON_MAX = 500;

/** Realtime hodisa (summasiz) — ochiq kassa sahifalari qayta o'qisin. */
export const PAYMENT_CORRECTED_REALTIME_EVENT = 'finance.payment.corrected';
