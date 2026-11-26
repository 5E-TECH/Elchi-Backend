/**
 * «Tashqi saytlar» importi: mahsulot qatori `order_items` ustunlariga SIG'SIN.
 *
 * Matn (`external-items-text.ts`) va massiv (`receiveExternalOrders`) yo'llari
 * uchun bitta chegara. Sig'magan qiymat `create()` ni yiqitadi; import tsikli
 * bittalab ketgani uchun partiya yarim yo'lda uziladi va shu qatorning mijozi
 * buyurtmasiz qoladi.
 *
 * Elchi-Frontend `src/pages/new_orders/sites/model/` ham shu chegarani
 * qo'llaydi — ro'yxatda ko'ringan nom va son buyurtmaga aynan yozilsin.
 */

/** `order_items.product_name` — varchar(255). */
const PRODUCT_NAME_MAX = 255;
/** `order_items.quantity` va `orders.product_quantity` — int4. */
const QUANTITY_MAX = 2_147_483_647;

/** Belgilar bo'yicha (surrogat juftlik bo'linmasin) ustun sig'imiga kesadi. */
export const fitProductName = (name: string): string =>
  Array.from(name).slice(0, PRODUCT_NAME_MAX).join('');

/** Musbat butun va int4 ga sig'adigan son; aks holda (kasr ham) — 1. */
export const fitQuantity = (quantity: number): number =>
  Number.isInteger(quantity) && quantity > 0 && quantity <= QUANTITY_MAX
    ? quantity
    : 1;

/**
 * Sonlar yig'indisi `orders.product_quantity` ga yoziladi: yig'indini int4 dan
 * oshiradigan qatorning soni — 1 (alohida sig'magan son kabi).
 */
export function fitTotalQuantity<T extends { quantity: number }>(
  rows: T[],
): T[] {
  let left = QUANTITY_MAX - rows.length;
  return rows.map((row) => {
    const extra = row.quantity - 1;
    if (extra > left) return { ...row, quantity: 1 };
    left -= extra;
    return row;
  });
}
