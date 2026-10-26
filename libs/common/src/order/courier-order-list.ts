import { Order_status } from '../../enums';

/**
 * Kuryer ro'yxati (GET /orders/courier/orders) holat tanlanmaganda — «Barchasi»
 * tabi — KO'RSATMAYDIGAN holatlar: buyurtma hali kuryer qo'liga yetmagan
 * (yaratilgan / yangi / filialga qabul qilingan / yo'lda).
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
};

/**
 * aLx7Di99 — kuryer buyurtmalari doirasi (`order.find_all` so'rovi) BITTA
 * joyda: kuryer pochtalari (`posts.courier_id = me`) ichidagi buyurtmalar;
 * holat berilsa — aynan o'sha holatlar, berilmasa — «Barchasi»
 * (`COURIER_LIST_HIDDEN_STATUSES` dan tashqari).
 *
 * Shu doirani ishlatadiganlar (raqamlar bir-biridan farq qilmasligi uchun):
 *  - gateway GET /orders/courier/orders (kuryer ro'yxati va `total`i);
 *  - order-service `order.courier_counts` (tab badge'lari: waiting / all);
 *  - logistics GET /region/my/district-stats (kuryer — /regions raqamlari).
 */
export function courierPostOrdersQuery(
  postIds: readonly string[],
  statuses?: readonly Order_status[] | null,
): CourierPostOrdersQuery {
  const status = statuses?.length ? [...statuses] : undefined;
  return {
    post_ids: [...postIds],
    status,
    exclude_statuses: status ? undefined : [...COURIER_LIST_HIDDEN_STATUSES],
  };
}
