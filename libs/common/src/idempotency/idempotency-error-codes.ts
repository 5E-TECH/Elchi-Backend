/**
 * (BOT-3d) Kuryer amali `Idempotency-Key` xatolarining mashina kodlari
 * (`PUBLIC_ERROR_CODES` ga ham qo'shilgan — FE / bot matnni tahlil qilmaydi).
 */
export const IDEMPOTENCY_ERROR_CODES = {
  /** Ayni kalit boshqa amal / buyurtma / tana bilan — 422. */
  KEY_MISMATCH: 'IDEMPOTENCY_KEY_MISMATCH',
  /** Ayni kalitli so'rov hali bajarilmoqda — 409. */
  IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
} as const;
