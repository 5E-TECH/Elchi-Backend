import { Order_status } from '../../enums';

/**
 * T8 (0OUcHZ7R) — maxsus belgilarni YARATILGANDAN KEYIN o'zgartirish qoidasi
 * (`order.special_categories.set`, PUT /orders/:id/special-categories).
 *
 *  - market / market operatori — faqat posilka hali qo'lidan chiqmagan
 *    holatda (`created`, `new`);
 *  - xodim (superadmin, admin, registrator, menejer, filial) — yo'lda va
 *    bekor qilingan posilkada ham (qaytishda ham ehtiyot bo'lish kerak);
 *  - yakunlangan buyurtma (`sold`, `paid`, `partly_paid`, `closed`,
 *    `returned_to_market`) — HECH KIM: tarix o'zgarmaydi.
 *
 * Ro'yxatda yo'q holat — qulflangan (fail-closed).
 */
export const SPECIAL_CATEGORIES_MARKET_EDITABLE_STATUSES: readonly Order_status[] =
  Object.freeze([Order_status.CREATED, Order_status.NEW]);

export const SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES: readonly Order_status[] =
  Object.freeze([
    Order_status.CREATED,
    Order_status.NEW,
    Order_status.RECEIVED,
    Order_status.ON_THE_ROAD,
    Order_status.WAITING,
    Order_status.WAITING_CUSTOMER,
    Order_status.CANCELLED,
    Order_status.CANCELLED_SENT,
  ]);

export const SPECIAL_CATEGORIES_ERROR_CODES = {
  /** Holat ruxsat etilmagan — 409 (`PUBLIC_ERROR_CODES` da). */
  LOCKED: 'SPECIAL_CATEGORIES_LOCKED',
} as const;

export const SPECIAL_CATEGORIES_LOCKED_MESSAGE =
  "Bu holatda maxsus belgini o'zgartirib bo'lmaydi";

/**
 * order_tracking.action. Jurnal verb'i (`order.special_categories_changed`)
 * chaqiruvda literal — action-registry AST tekshiruvi (y8CxCtcK) shuni talab
 * qiladi.
 */
export const SPECIAL_CATEGORIES_TRACKING_ACTION = 'special_categories_changed';

export type SpecialCategoriesEditorTier = 'market' | 'staff';

export function isSpecialCategoriesEditable(
  tier: SpecialCategoriesEditorTier,
  status: Order_status | string | null | undefined,
): boolean {
  const allowed =
    tier === 'market'
      ? SPECIAL_CATEGORIES_MARKET_EDITABLE_STATUSES
      : SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES;
  return allowed.includes(status as Order_status);
}
