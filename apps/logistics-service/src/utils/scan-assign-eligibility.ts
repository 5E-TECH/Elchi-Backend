import { Order_status, Post_status } from '@app/common';

/**
 * HQ KURYERI SKAN ORQALI O'ZIGA OLADIGAN BUYURTMA QOIDALARI (ITEM 5).
 *
 * HQ kuryeri faqat HQ QABUL QILGAN va HQ da jismonan turgan buyurtmani
 * oladi. Ilgari `scanAssignOrder` NEW buyurtmani kuryer nomidan
 * NEW → RECEIVED qilib yuborardi — ya'ni HQ ning haqiqiy qabuli
 * (`receiveNewOrders`: hamkor posilkalari, hudud pochtasi, filial tekshiruvi)
 * umuman ishlamasdi. Tranzit paketdagi (P1b) buyurtmani esa kuryer skani HQ
 * xodimisiz HQ ga "qabul qilib" qo'yardi.
 *
 * Bu fayl SOF: I/O yo'q, hech narsani o'zgartirmaydi. Tekshiruv HAR QANDAY
 * yozuvdan (pochta yaratish, status, hisoblagich, log) OLDIN ishlaydi — rad
 * etilgan buyurtma butunlay tegilmay qoladi.
 */

export const SCAN_ASSIGN_MESSAGES = {
  NOT_ACCEPTED_HQ:
    "Buyurtma hali HQ da qabul qilinmagan (holati: yangi) — uni kuryerga berib bo'lmaydi. Avval HQ registratori buyurtmani qabul qilishi kerak.",
  IN_TRANSIT:
    "Buyurtma yo'lda — filiallar orasidagi pochta yoki paket ichida. U qabul qilinmaguncha HQ kuryeri uni ololmaydi.",
  // `current_batch_id` PENDING (hali jo'natilmagan) paketda ham qo'yiladi —
  // buyurtma o'shanda HQ da RECEIVED turadi, "yo'lda" deyish yolg'on bo'lardi.
  IN_BATCH:
    "Buyurtma paketga joylangan — paket jo'natilib qabul qilinmaguncha HQ kuryeri uni ololmaydi.",
  NOT_AT_HQ:
    'Buyurtma HQ da emas — boshqa filialda turibdi. HQ kuryeri faqat HQ da turgan buyurtmani oladi.',
  // Mavjud matn ATAYLAB qayta ishlatiladi (filial kuryeri ham aynan shuni oladi).
  WITH_OTHER_COURIER: 'Order allaqachon boshqa courierga biriktirilgan',
  WRONG_STATUS:
    "Order holati noto'g'ri: faqat RECEIVED yoki WAITING_CUSTOMER bo'lishi kerak",
} as const;

/** Yakunlangan holatlar — bunday buyurtmani hech bir kuryerga berib bo'lmaydi. */
export const FINISHED_ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  [Order_status.SOLD]: 'sotilgan',
  [Order_status.PAID]: "to'langan",
  [Order_status.PARTLY_PAID]: "qisman to'langan",
  [Order_status.CANCELLED]: 'bekor qilingan',
  [Order_status.CANCELLED_SENT]: "bekor qilinib pochtaga qo'shilgan",
  [Order_status.RETURNED_TO_MARKET]: 'marketga qaytarilgan',
  [Order_status.CLOSED]: 'yopilgan',
};

export const finishedOrderMessage = (label: string): string =>
  `Buyurtma ${label} — uni kuryerga berib bo'lmaydi.`;

export type HqCourierScanRejectionReason =
  | 'NOT_ACCEPTED'
  | 'FINISHED'
  | 'WITH_OTHER_COURIER'
  | 'IN_BATCH'
  | 'IN_TRANSIT'
  | 'NOT_AT_HQ'
  | 'WRONG_STATUS';

export interface HqCourierScanRejection {
  statusCode: 400 | 403;
  message: string;
  reason: HqCourierScanRejectionReason;
}

type IdLike = string | number | null | undefined;

export interface HqCourierScanInput {
  order: {
    status?: string | null;
    branch_id?: IdLike;
    holder_branch_id?: IdLike;
    holder_courier_id?: IdLike;
    courier_id?: IdLike;
    current_batch_id?: IdLike;
  };
  /** Buyurtmaning hozirgi pochtasi (`order.post_id`), bo'lmasa `null`. */
  orderPost: { status?: string | null; courier_id?: IdLike } | null;
  hqBranchId: IdLike;
  requesterId: IdLike;
}

const normalizeId = (value: IdLike): string => String(value ?? '').trim();

const normalizeStatus = (value?: string | null): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const reject = (
  statusCode: 400 | 403,
  message: string,
  reason: HqCourierScanRejectionReason,
): HqCourierScanRejection => ({ statusCode, message, reason });

/**
 * HQ kuryeri skanini baholaydi. `null` — ruxsat (odatdagi biriktirish yoki
 * kuryerning o'z buyurtmasini qayta skanlashi), aks holda rad etish sababi.
 *
 * Qoidalar TARTIB BILAN tekshiriladi, birinchi mos kelgani g'olib:
 * 1. NEW → hali HQ qabul qilmagan.
 * 2. Yakunlangan holat (sotilgan, bekor, qaytarilgan...) → berib bo'lmaydi.
 * 3. Boshqa kuryerda (`courier_id` yoki `holder_courier_id`) → band.
 * 4. Paketda (`current_batch_id`) → yo'lda (ON_THE_ROAD) yoki paketga joylangan.
 * 5. HQ da emas (`branch_id` yoki `holder_branch_id` boshqa filial) → yo'lda
 *    (ON_THE_ROAD, boshqa kuryer) yoki boshqa filialda (403).
 * 6. ON_THE_ROAD → faqat shu kuryerning o'zi qayta skanlasa ruxsat.
 * 7. Buyurtma pochtasi boshqa birovga jo'natilgan (SENT) → yo'lda.
 * 8. RECEIVED yoki WAITING_CUSTOMER → ruxsat.
 * 9. Qolgan hamma holat → noto'g'ri holat.
 */
export function assessHqCourierScan(
  input: HqCourierScanInput,
): HqCourierScanRejection | null {
  const { order, orderPost } = input;
  const hqBranchId = normalizeId(input.hqBranchId);
  const requesterId = normalizeId(input.requesterId);
  const status = normalizeStatus(order.status);
  const courierId = normalizeId(order.courier_id);
  const holderCourierId = normalizeId(order.holder_courier_id);
  const branchId = normalizeId(order.branch_id);
  const holderBranchId = normalizeId(order.holder_branch_id);
  const batchId = normalizeId(order.current_batch_id);
  const isOnTheRoad = status === String(Order_status.ON_THE_ROAD);

  if (status === String(Order_status.NEW)) {
    return reject(400, SCAN_ASSIGN_MESSAGES.NOT_ACCEPTED_HQ, 'NOT_ACCEPTED');
  }

  const finishedLabel = FINISHED_ORDER_STATUS_LABELS[status];
  if (finishedLabel) {
    return reject(400, finishedOrderMessage(finishedLabel), 'FINISHED');
  }

  if (
    (courierId && courierId !== requesterId) ||
    (holderCourierId && holderCourierId !== requesterId)
  ) {
    return reject(
      400,
      SCAN_ASSIGN_MESSAGES.WITH_OTHER_COURIER,
      'WITH_OTHER_COURIER',
    );
  }

  if (batchId) {
    // "Yo'lda" matni FAQAT haqiqatan yo'ldagi (jo'natilgan FORWARD paket)
    // buyurtma uchun. PENDING paketdagi buyurtma hamon HQ da RECEIVED turadi.
    return isOnTheRoad
      ? reject(400, SCAN_ASSIGN_MESSAGES.IN_TRANSIT, 'IN_TRANSIT')
      : reject(400, SCAN_ASSIGN_MESSAGES.IN_BATCH, 'IN_BATCH');
  }

  if (
    branchId !== hqBranchId ||
    (holderBranchId && holderBranchId !== hqBranchId)
  ) {
    // Filialga jo'natilgan (dispatch) buyurtma ON_THE_ROAD bo'ladi va uning
    // `branch_id`si allaqachon manzil filial — bu "boshqa filialda" emas, yo'lda.
    return isOnTheRoad && courierId !== requesterId
      ? reject(400, SCAN_ASSIGN_MESSAGES.IN_TRANSIT, 'IN_TRANSIT')
      : reject(403, SCAN_ASSIGN_MESSAGES.NOT_AT_HQ, 'NOT_AT_HQ');
  }

  if (isOnTheRoad) {
    // O'z buyurtmasini qayta skanlash — mavjud idempotent yo'l ishlaydi.
    return courierId === requesterId
      ? null
      : reject(400, SCAN_ASSIGN_MESSAGES.IN_TRANSIT, 'IN_TRANSIT');
  }

  if (
    orderPost &&
    normalizeStatus(orderPost.status) === String(Post_status.SENT) &&
    normalizeId(orderPost.courier_id) !== requesterId
  ) {
    return reject(400, SCAN_ASSIGN_MESSAGES.IN_TRANSIT, 'IN_TRANSIT');
  }

  if (
    status === String(Order_status.RECEIVED) ||
    status === String(Order_status.WAITING_CUSTOMER)
  ) {
    return null;
  }

  return reject(400, SCAN_ASSIGN_MESSAGES.WRONG_STATUS, 'WRONG_STATUS');
}
