/**
 * Smena yopishda karta qoldig'ini tasdiqlash (kiZgTybn) — gateway ↔
 * finance-service umumiy kontrakti.
 *
 * BE-B (ega 2026-11-10: «24 soat ichida keyin yuklash»): ASOSIY kassa smenasi
 * AVTOMATIK yopilsa, kassir karta qoldig'i skrinshotlarini yuklay olmagan —
 * superadmin / admin ularni `closed_at` dan keyin 24 soat ichida
 * `POST /finance/shift/:shift_id/accounts/:card_id/late-photo` bilan yuklaydi.
 * Xato kodlari `PUBLIC_ERROR_CODES` ga ham qo'shilgan (FE matnni emas, kodni
 * tekshiradi).
 */

/** Javobdagi `code`. */
export const SHIFT_LATE_PHOTO_ERROR_CODES = {
  /** 400 — smena ASOSIY (MAIN, `cashbox_user_id = '0'`) kassaniki emas. */
  MAIN_ONLY: 'SHIFT_LATE_PHOTO_MAIN_ONLY',
  /** 409 — smena hali ochiq yoki qo'lda yopilgan (avtomatik yopilmagan). */
  NOT_AUTO_CLOSED: 'SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED',
  /** 409 — 24 soatlik oyna tugagan; `deadline` (ISO) — qachongacha edi. */
  EXPIRED: 'SHIFT_LATE_PHOTO_EXPIRED',
  /** 404 — bu karta uchun smenada snapshot qatori yo'q. */
  CARD_NOT_IN_SHIFT: 'SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT',
} as const;

export type ShiftLatePhotoErrorCode =
  (typeof SHIFT_LATE_PHOTO_ERROR_CODES)[keyof typeof SHIFT_LATE_PHOTO_ERROR_CODES];

export const SHIFT_LATE_PHOTO_MESSAGES: Readonly<
  Record<ShiftLatePhotoErrorCode, string>
> = Object.freeze({
  SHIFT_LATE_PHOTO_MAIN_ONLY:
    'Rasmni keyin yuklash faqat asosiy kassa smenasi uchun',
  SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED:
    'Rasmni keyin yuklash faqat avtomatik yopilgan smena uchun',
  SHIFT_LATE_PHOTO_EXPIRED:
    "Rasmni keyin yuklash muddati tugagan (smena yopilganidan 24 soat o'tdi)",
  SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT: "Bu karta shu smena hisobotida yo'q",
});

/** Hisobot qatoridagi hisoblangan `photo_status` (DB'da saqlanmaydi). */
export const SHIFT_ACCOUNT_PHOTO_STATUSES = [
  'not_required',
  'uploaded',
  'pending',
  'missing',
] as const;

export type ShiftAccountPhotoStatus =
  (typeof SHIFT_ACCOUNT_PHOTO_STATUSES)[number];
