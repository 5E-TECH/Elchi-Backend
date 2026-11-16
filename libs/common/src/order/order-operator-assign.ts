import { Order_status } from '../../enums';

/**
 * 2026-11-16 (Dilshod): «buyurtma yaratayotganda operatorni o'zi yaratsa
 * operator tomonidan yaratilsin, operator tanlanmasa shu buyurtmaga operator
 * biriktirib qo'yish imkoni bo'lishi kerak».
 *
 * Yaratishdagi tanlov (`POST /orders` `operator_id`) va market operatorining
 * o'zi yozilishi avvaldan bor (`order-create/order-chosen-operator.ts`).
 * Bu — YARATILGANDAN KEYIN biriktirish: `PUT /orders/:id/operator` →
 * `order.operator.assign`.
 *
 *  - faqat operatori YO'Q buyurtmaga (`operator_id IS NULL`) — bor bo'lsa 409
 *    `ORDER_OPERATOR_ALREADY_ASSIGNED` (almashtirish emas, biriktirish);
 *  - tashqi integratsiya buyurtmasi (`operator = 'external_…'`) — 409
 *    `ORDER_OPERATOR_EXTERNAL`: u matn hamkor holat sinxroni kaliti;
 *  - operator — buyurtma marketining FAOL operatori (yaratishdagi tanlov bilan
 *    AYNI tekshiruv, gateway'da); tekshiruvdan keyin market o'zgargan bo'lsa —
 *    409 `ORDER_OPERATOR_MARKET_CHANGED` (qayta urinish);
 *  - buyurtma allaqachon sotilgan bo'lsa (`ORDER_OPERATOR_EARNING_STATUSES`) —
 *    sotuvdagidek operator ulushi yoziladi (`finance.operator.earning.record`,
 *    `order_id` bo'yicha idempotent).
 */
export const ORDER_OPERATOR_ERROR_CODES = {
  /** Buyurtmada operator bor — 409. */
  ALREADY_ASSIGNED: 'ORDER_OPERATOR_ALREADY_ASSIGNED',
  /** Tashqi integratsiya buyurtmasi — 409. */
  EXTERNAL: 'ORDER_OPERATOR_EXTERNAL',
  /** Tekshiruvdan keyin buyurtma marketi o'zgardi — 409. */
  MARKET_CHANGED: 'ORDER_OPERATOR_MARKET_CHANGED',
} as const;

export const ORDER_OPERATOR_ALREADY_ASSIGNED_MESSAGE =
  'Bu buyurtmaga operator allaqachon biriktirilgan';
export const ORDER_OPERATOR_EXTERNAL_MESSAGE =
  "Integratsiya buyurtmasiga operator biriktirib bo'lmaydi";
export const ORDER_OPERATOR_MARKET_CHANGED_MESSAGE =
  "Buyurtma marketi o'zgardi — sahifani yangilab, qayta urinib ko'ring";

/**
 * order_tracking.action. Jurnal verb'i (`order.operator_assigned`) chaqiruvda
 * literal — action-registry AST tekshiruvi (y8CxCtcK) shuni talab qiladi.
 */
export const ORDER_OPERATOR_ASSIGN_TRACKING_ACTION = 'operator_assigned';

/**
 * Biriktirilganda operator ulushi darhol yoziladigan holatlar — sotuvdagi
 * `enqueueFinanceOnStatusChange` dagi «sotilgan» to'plam bilan AYNI.
 */
export const ORDER_OPERATOR_EARNING_STATUSES: readonly Order_status[] =
  Object.freeze([
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
  ]);

/** Tashqi integratsiya buyurtmasi: `operator` matni `external_` bilan boshlanadi. */
export function isExternalOperatorText(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('external_');
}
