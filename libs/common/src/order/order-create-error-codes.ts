/**
 * Buyurtma yaratish (`POST /orders`, `POST /orders/ai-confirm`) — mashina
 * o'qiydigan xato kodlari (#658 xato kontrakti, UPPER_CASE).
 *
 * Ilgari bu 400'lar faqat o'zbekcha matn edi; Telegram bot (ai-confirm
 * natijasi) va FE ularni MATN bo'yicha tanib olishga majbur edi (mo'rt).
 * Endi:
 *  - `POST /orders` — 400 tanasida `code` (matn o'zgarmagan);
 *  - `POST /orders/ai-confirm` — shu buyurtma natijasida `reason_code`
 *    (`code` — avvalgidek `create_failed`).
 */
export const ORDER_CREATE_ERROR_CODES = {
  /** Market raqamni majburiy qilgan, doimiy raqam yo'q, raqam yuborilmagan. */
  OPERATOR_PHONE_REQUIRED: 'OPERATOR_PHONE_REQUIRED',
  /** Tanlangan operator buyurtma marketining faol operatori emas. */
  CHOSEN_OPERATOR_NOT_SELECTABLE: 'CHOSEN_OPERATOR_NOT_SELECTABLE',
  /** Market operatori boshqa operatorni tanlagan (faqat o'zini mumkin). */
  CHOSEN_OPERATOR_SELF_ONLY: 'CHOSEN_OPERATOR_SELF_ONLY',
} as const;

export type OrderCreateErrorCode =
  (typeof ORDER_CREATE_ERROR_CODES)[keyof typeof ORDER_CREATE_ERROR_CODES];
