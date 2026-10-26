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
