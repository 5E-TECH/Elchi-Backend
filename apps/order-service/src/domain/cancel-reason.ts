import { CancelReason } from '@app/common';

/**
 * Bekor qilish sababi (yopiq ro'yxat, PUvKXWVw) — o'zbekcha yorliqlar.
 *
 * Bildirishnoma matni (`order-notification.service`) va sabablar
 * statistikasi (`GET /orders/cancel-reasons/stats`) AYNI manbadan oladi —
 * ikki joyda ikki xil nom chiqmasin.
 */
export const CANCEL_REASON_UZ: Readonly<Record<string, string>> = {
  [CancelReason.CUSTOMER_NO_ANSWER]: 'Mijoz javob bermadi',
  [CancelReason.CUSTOMER_REFUSED]: 'Mijoz rad etdi',
  [CancelReason.WRONG_ADDRESS]: "Manzil noto'g'ri",
  [CancelReason.DEFECTIVE_PRODUCT]: 'Mahsulot nuqsonli',
  [CancelReason.PRICE_DISPUTE]: "Narx bo'yicha kelishmovchilik",
  [CancelReason.OTHER]: 'Boshqa',
};

/**
 * Sababi qayd etilmagan bekor qilish: yopiq ro'yxat kiritilishidan OLDINGI
 * bekorlar (`return_reason` NULL) yoki ro'yxatda yo'q eski erkin matn
 * (masalan qaytarish so'rovidan qolgan `return_reason`).
 */
export const CANCEL_REASON_UNKNOWN = 'UNKNOWN';
export const CANCEL_REASON_UNKNOWN_UZ = 'Sabab qayd etilmagan';
