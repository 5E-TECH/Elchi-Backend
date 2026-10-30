/**
 * Mijozga ko'rinadigan buyurtma raqami (chek, QR yorlig'i, ro'yxat):
 * «EL-» + (id + 100000) — masalan id=81 → "EL-100081". id'dan hosil qilinadi
 * (ustun yo'q), deterministik va noyob. YAGONA manba: order-service, gateway
 * (pochta buyurtmalari, T9) va bildirishnomalar shu funksiyadan oladi.
 */
export const ORDER_NUMBER_OFFSET = 100000;

/** Musbat butun id → "EL-…"; noto'g'ri / bo'sh id → `null`. */
export function formatOrderNumber(id: unknown): string | null {
  const text =
    typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
  const numeric = Number(text);
  return text !== '' && Number.isSafeInteger(numeric) && numeric > 0
    ? `EL-${numeric + ORDER_NUMBER_OFFSET}`
    : null;
}
