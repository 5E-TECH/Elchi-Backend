/**
 * Buyurtma rollback (`POST /orders/rollback/:id`) — mashina o'qiydigan xato
 * kodlari va FE oynasida ko'rsatiladigan o'zbekcha matnlar (ega qarorlari
 * D1–D4, 2026-11-19).
 *
 * Bitta manba: `evaluateRollbackEligibility` (order-service) shu kodlarni
 * qaytaradi; endpoint ham, buyurtma ro'yxati / tafsilotidagi
 * `rollback: { allowed, code, message }` maydoni ham shu funksiyadan.
 */
export const ORDER_ROLLBACK_ERROR_CODES = {
  /** Rol rollback qila olmaydi (faqat superadmin, menejer, kuryer). */
  NOT_ALLOWED_ROLE: 'NOT_ALLOWED_ROLE',
  /** Buyurtma holati qaytariladigan holat emas. */
  STATUS_NOT_ROLLBACKABLE: 'STATUS_NOT_ROLLBACKABLE',
  /** Sotuv amali qaydi (`sold_at`) yo'q — kassa teskari yozilmaydi. */
  NO_SALE_RECORD: 'NO_SALE_RECORD',
  /** D3 — menejerda «sotish / bekor qilish» huquqi (`can_sell_cancel`) yo'q. */
  NO_PERMISSION: 'NO_PERMISSION',
  /** Menejer: buyurtma uning filialiga tegishli emas. */
  NOT_OWN_BRANCH: 'NOT_OWN_BRANCH',
  /** Kuryer: buyurtma unga biriktirilmagan. */
  NOT_OWN_ORDER: 'NOT_OWN_ORDER',
  /** D4 — bekor posilka filialdan / kuryerdan chiqib ketgan (jo'natilgan). */
  PARCEL_NOT_IN_BRANCH: 'PARCEL_NOT_IN_BRANCH',
  /** D2 — pul HQ'ga o'tgan / market to'langan / filial marketga to'lagan. */
  SUPERADMIN_ONLY: 'SUPERADMIN_ONLY',
  /** Kuryer pulni filialga topshirgan — kuryer o'zi qaytara olmaydi. */
  COURIER_REMITTED: 'COURIER_REMITTED',
  /** Daftar holati avtomatik teskari yozishga yaramaydi — buxgalteriya tuzatishi. */
  CORRECTION_REQUIRED: 'CORRECTION_REQUIRED',
} as const;

export type OrderRollbackErrorCode =
  (typeof ORDER_ROLLBACK_ERROR_CODES)[keyof typeof ORDER_ROLLBACK_ERROR_CODES];

/** Har kod uchun standart matn (aniq sabab bo'lsa `message` uni almashtiradi). */
export const ORDER_ROLLBACK_MESSAGES: Record<OrderRollbackErrorCode, string> = {
  NOT_ALLOWED_ROLE:
    'Buyurtmani qaytarish faqat superadmin, menejer va kuryer uchun',
  STATUS_NOT_ROLLBACKABLE: 'Bu holatdagi buyurtmani qaytarib bo‘lmaydi',
  NO_SALE_RECORD:
    'Bu buyurtma sotish amali orqali sotilmagan (sotuv vaqti yo‘q) — rollback kassaga teskari yozuv qila olmaydi. Superadminga murojaat qiling',
  NO_PERMISSION:
    'Sizda buyurtmani sotish / bekor qilish huquqi yo‘q — qaytarish ham mumkin emas',
  NOT_OWN_BRANCH: 'Buyurtma sizning filialingizga tegishli emas',
  NOT_OWN_ORDER: 'Buyurtma sizga biriktirilmagan',
  PARCEL_NOT_IN_BRANCH:
    'Posilka filialdan jo‘natilgan (bekorlar paketi, pochta, HQ yoki market) — qaytarib bo‘lmaydi',
  SUPERADMIN_ONLY: 'Faqat superadmin qaytara oladi',
  COURIER_REMITTED:
    'Pul filialga topshirilgan — buyurtmani menejer yoki superadmin qaytaradi',
  CORRECTION_REQUIRED:
    'Hisob-kitob holati avtomatik qaytarishga yaramaydi — buxgalteriya tuzatishi kerak',
};

/** Ro'yxat / tafsilotdagi `rollback` maydoni. */
export interface OrderRollbackEligibility {
  allowed: boolean;
  code: OrderRollbackErrorCode | null;
  message: string | null;
}
