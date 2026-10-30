/**
 * T1 K1 (s6xY4f5C) — hamkor sotuvchisi ↔ MAVJUD Elchi marketi bog'lanishi
 * (`POST /admin/partners/:id/markets`). Xato javobidagi mashina kodlari
 * (`PUBLIC_ERROR_CODES` ga ham qo'shilgan) — 409.
 */
export const PARTNER_MARKET_ERROR_CODES = {
  /** Shu hamkorda bu `external_seller_id` allaqachon faol bog'langan. */
  SELLER_TAKEN: 'PARTNER_SELLER_TAKEN',
  /** Market boshqa hamkorning faol sotuvchisiga bog'langan. */
  MARKET_TAKEN: 'PARTNER_MARKET_TAKEN',
} as const;
