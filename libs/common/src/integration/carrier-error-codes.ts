/**
 * Carrier API (`/carrier/*`) xato kodlari — tashqi yetkazuvchi dasturi
 * xabar MATNIGA emas, shu kodlarga tayanadi (matn o'zgarishi mumkin).
 * Xato javobiga `code` sifatida chiqadi (`PUBLIC_ERROR_CODES`).
 *
 * Kontrakt: docs/public/CARRIER_API.md §3.
 */
export const CARRIER_ERROR_CODES = {
  /** 503 — kalitni tekshirib bo'lmadi (RMQ/identity uzilishi). Qayta urining. */
  KEY_CHECK_UNAVAILABLE: 'CARRIER_KEY_CHECK_UNAVAILABLE',
  /** 403 — bog'langan kurier bloklangan / o'chirilgan. Elchi'ga murojaat. */
  COURIER_INACTIVE: 'CARRIER_COURIER_INACTIVE',
  /** 400 — `POST /carrier/orders/:id/status` da `Idempotency-Key` yo'q. */
  IDEMPOTENCY_KEY_REQUIRED: 'CARRIER_IDEMPOTENCY_KEY_REQUIRED',
  /**
   * 409 — kalit OLDINGI urinishga tegishli: amal qayta bajarilmadi (masalan
   * sold → rollback → sold ayni kalit bilan). Yangi kalit bilan yuboring.
   */
  IDEMPOTENCY_KEY_STALE: 'CARRIER_IDEMPOTENCY_KEY_STALE',
  /** 503 — vaqtinchalik ichki xato (qidiruv/geo). Ayni kalit bilan qayta urining. */
  TEMPORARILY_UNAVAILABLE: 'CARRIER_TEMPORARILY_UNAVAILABLE',
} as const;
