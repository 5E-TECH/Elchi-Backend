/**
 * vbu7Wr3o (prod E2E Surxondaryo, 2026-10-26) — pochta QABULI tracking'i.
 *
 * Ilgari filial menejeri / kuryer pochtani qabul qilganda logistics
 * `order.update` ni so'rovchisiz chaqirardi: tarixda `changed_by: system`,
 * `action: waiting`, «Buyurtma kutilmoqda holatiga qaytarildi» yozilardi va
 * frontend uni «Tizim buyurtmani kutilmoqda holatiga qaytardi» deb ko'rsatardi
 * (buyurtmalar 129, 131, 132, 133). Endi logistics qabul qilgan xodimni va
 * shu izohlardan birini uzatadi, order-service esa yozuvni `post_received`
 * amali bilan (qabul qilgan xodim nomidan) yozadi.
 */
export const POST_RECEIVED_TRACKING_ACTION = 'post_received';

export const POST_RECEIVED_TRACKING_NOTES = {
  /** Filial (menejer / registrator) pochtani qabul qildi. */
  BRANCH: 'Post received by branch',
  /** Kuryer o'ziga biriktirilgan pochtani qabul qildi. */
  COURIER: 'Post received by courier',
} as const;

export type PostReceiveKind = keyof typeof POST_RECEIVED_TRACKING_NOTES;

/** Izoh pochta qabuliga tegishli bo'lsa — qabul turi, aks holda `null`. */
export function postReceiveKindOfNote(
  note: string | null | undefined,
): PostReceiveKind | null {
  const normalized = String(note ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  for (const kind of Object.keys(
    POST_RECEIVED_TRACKING_NOTES,
  ) as PostReceiveKind[]) {
    if (POST_RECEIVED_TRACKING_NOTES[kind].toLowerCase() === normalized) {
      return kind;
    }
  }
  return null;
}

/**
 * vbu7Wr3o #2 — HQ → filial jo'natish izohi (branch-service yozadi):
 * «Post #35 HQ'dan branch #12 ga dispatch qilindi». Undagi filial id —
 * YOZUV paytidagi manzil (buyurtmaning joriy filiali EMAS).
 */
const DISPATCH_NOTE_BRANCH_ID = /HQ'dan branch #(\d+) ga dispatch qilindi/i;

export function dispatchNoteBranchId(
  note: string | null | undefined,
): string | null {
  const match = DISPATCH_NOTE_BRANCH_ID.exec(String(note ?? ''));
  return match ? match[1] : null;
}

/**
 * COURIER-SCAN (ega, 2026-11-17) — kuryer skani = QABUL. Kuryer QR'ni
 * skanerlab buyurtmani oldi — u darhol «Kutilmoqda» (WAITING) bo'ladi va
 * kuryer qo'lida: «Yo'lda» ga qaytmaydi, alohida «Qabul qilish» qadami yo'q.
 *
 * Logistics `scan-assign` `order.update` ga shu izohlardan birini (kuryer
 * nomidan) uzatadi, order-service esa tarix qatorini shu amal bilan yozadi:
 *   - `TAKE` — kuryer skan bilan oldi (`courier_scan_received`, «Kuryer
 *     <ism> skan bilan oldi»): yangi biriktirish (NEW / RECEIVED / WAITING /
 *     mijoz kutilmoqda → WAITING) va kuryerning o'zidagi yo'ldagi buyurtmani
 *     qayta skanlash (ON_THE_ROAD → WAITING). Holat o'zgarmasa (filial
 *     qabul qilgan WAITING buyurtma) ham tarixda bitta qator yoziladi;
 *   - `BRANCH_RECEIVE` — HQ → filial o'tkazma pochtasidagi buyurtmani
 *     menejer qabul qilmasdan kuryer skani filialga qabul qildi
 *     (`branch_post_received_by_courier_scan`, P1b paketidagi
 *     `branch_batch_received_by_scan` kabi): mas'uliyat zanjiri HQ → filial
 *     (kuryer skani) → kuryer uzilmaydi.
 * «Kuryer pochtani qabul qildi» (`post_received`) — faqat pochtaning o'zini
 * qabul qilishda (pochta tafsilotidagi «Pochtani qabul qilish»).
 */
export const COURIER_SCAN_RECEIVED_TRACKING_ACTION = 'courier_scan_received';
export const BRANCH_POST_RECEIVED_BY_COURIER_SCAN_TRACKING_ACTION =
  'branch_post_received_by_courier_scan';

export const COURIER_SCAN_TRACKING_NOTES = {
  /** Kuryer buyurtmani skan bilan oldi (holat — WAITING, kuryerda). */
  TAKE: 'Order skan orqali courierga biriktirildi',
  /** O'tkazma pochtasidagi buyurtma kuryer skani bilan filialga qabul qilindi. */
  BRANCH_RECEIVE: 'Order kuryer skani orqali filialga qabul qilindi',
} as const;

export type CourierScanTrackingKind = keyof typeof COURIER_SCAN_TRACKING_NOTES;

/** Izoh kuryer skaniga tegishli bo'lsa — turi, aks holda `null`. */
export function courierScanKindOfNote(
  note: string | null | undefined,
): CourierScanTrackingKind | null {
  const normalized = String(note ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  for (const kind of Object.keys(
    COURIER_SCAN_TRACKING_NOTES,
  ) as CourierScanTrackingKind[]) {
    if (COURIER_SCAN_TRACKING_NOTES[kind].toLowerCase() === normalized) {
      return kind;
    }
  }
  return null;
}
