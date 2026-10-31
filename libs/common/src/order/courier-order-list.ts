import { Order_status } from '../../enums';

/**
 * Kuryer ro'yxati (GET /orders/courier/orders) holat tanlanmaganda — «Barchasi»
 * tabi — KO'RSATMAYDIGAN holatlar: buyurtma hali kuryer qo'liga yetmagan
 * (yaratilgan / yangi / filialga qabul qilingan / yo'lda). Yagona istisno —
 * kuryer skan bilan o'zi olgan posilka (`isCourierScanTakenOrder`).
 */
export const COURIER_LIST_HIDDEN_STATUSES: readonly Order_status[] =
  Object.freeze([
    Order_status.CREATED,
    Order_status.NEW,
    Order_status.RECEIVED,
    Order_status.ON_THE_ROAD,
  ]);

export type CourierPostOrdersQuery = {
  post_ids: string[];
  status?: Order_status[];
  exclude_statuses?: Order_status[];
  /** 6qypMFeT: shu kuryer skan bilan olgan ON_THE_ROAD qatorlar ham kiradi. */
  scan_taken_courier_id?: string;
};

/**
 * 6qypMFeT — kuryer skan bilan O'ZI olgan posilka: `scan-assign` uni
 * ON_THE_ROAD + SENT pochtaga qo'yadi, lekin posilka allaqachon qo'lida.
 * Belgi — topshirishni kuryerning o'zi yozgani (`last_handover_by`): menejer
 * biriktirgan yoki jo'natilgan pochtada u xodim id'si, shu sabab qabul
 * qilinmagan pochta yashirin qoladi. Pochta qabulida rad etilgani
 * (`return_requested`) qo'lda emas. Order-service'dagi SQL shartning aynan
 * nusxasi (`buildOrderListQuery`).
 */
export function isCourierScanTakenOrder(
  order: {
    status?: string | null;
    holder_type?: string | null;
    holder_courier_id?: string | null;
    last_handover_by?: string | null;
    return_requested?: boolean | null;
  },
  courierId: string,
): boolean {
  const id = String(courierId ?? '').trim();
  return (
    Boolean(id) &&
    order.status === Order_status.ON_THE_ROAD &&
    order.holder_type === 'COURIER' &&
    String(order.holder_courier_id ?? '') === id &&
    String(order.last_handover_by ?? '') === id &&
    !order.return_requested
  );
}

/**
 * aLx7Di99 — kuryer buyurtmalari doirasi (`order.find_all` so'rovi) BITTA
 * joyda: kuryer pochtalari (`posts.courier_id = me`) ichidagi buyurtmalar;
 * holat berilsa — aynan o'sha holatlar, berilmasa — «Barchasi»
 * (`COURIER_LIST_HIDDEN_STATUSES` dan tashqari).
 *
 * 6qypMFeT: `courierId` berilsa, «Barchasi» va «Kutilayotgan» (WAITING) ga
 * kuryer skan bilan olgan posilka ham kiradi — u qo'lda, kuryer ro'yxatni
 * sukut bo'yicha «Kutilayotgan» tabida ochadi. Holat ON_THE_ROAD qoladi:
 * sotish hali pochta qabulidan keyin.
 *
 * Shu doirani ishlatadiganlar (raqamlar bir-biridan farq qilmasligi uchun):
 *  - gateway GET /orders/courier/orders (kuryer ro'yxati va `total`i);
 *  - order-service `order.courier_counts` (tab badge'lari: waiting / all);
 *  - logistics GET /region/my/district-stats (kuryer — /regions raqamlari).
 */
export function courierPostOrdersQuery(
  postIds: readonly string[],
  statuses?: readonly Order_status[] | null,
  courierId?: string | null,
): CourierPostOrdersQuery {
  const status = statuses?.length ? [...statuses] : undefined;
  const scanTakenCourierId = String(courierId ?? '').trim();
  const includesScanTaken =
    Boolean(scanTakenCourierId) &&
    (!status || status.includes(Order_status.WAITING));
  return {
    post_ids: [...postIds],
    status,
    exclude_statuses: status ? undefined : [...COURIER_LIST_HIDDEN_STATUSES],
    ...(includesScanTaken ? { scan_taken_courier_id: scanTakenCourierId } : {}),
  };
}
