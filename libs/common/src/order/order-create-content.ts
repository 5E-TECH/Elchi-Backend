/**
 * IR2OHIiN — MAHSULOTSIZ VA TUMANSIZ BUYURTMA YARATILMAYDI (ega qarori,
 * 2026-10-25: «bunaqa umuman yaratilmasligi kerak hech qayerdan»).
 *
 * Prod'da `POST /orders` ga market tokeni bilan to'g'ridan-to'g'ri so'rov
 * «Buyurtmada mahsulot yo'q», «Tuman/Viloyat: —» buyurtma yaratardi (gateway
 * DTO'sida `items` ixtiyoriy edi, `district_id` esa buyurtmaga umuman
 * yozilmasligi mumkin edi — bot va filial yo'llari mijozdagi tumanni
 * buyurtmaga ko'chirmasdi). Bunday buyurtmani kuryerga yo'naltirib bo'lmaydi,
 * narx/hisob buziladi.
 *
 * Qoida (gateway DTO + `createOrderInternal` va order-service
 * `OrderLifecycleService.create` — YAGONA yaratish nuqtasi — uchun bitta
 * manba):
 *   1. kamida bitta mahsulot qatori, har qator miqdori butun son ≥ 1
 *      (berilmasa — 1, order-service sukuti);
 *   2. tuman: buyurtmaning `district_id` si yoki mijozniki (inline `customer`
 *      yoki mavjud mijoz) — u BUYURTMAGA yoziladi, viloyat tumandan.
 *
 * ⚠️ Hamkor/integratsiya yo'llari (BeePost `POST /partner/shipments`,
 * tashqi saytlar importi `order.receive_external`) bu qoidadan ATAYLAB
 * chiqarilgan — ular Shodiyorning hududi, alohida karta
 * (`isIntegrationOrderCreate`, order-service).
 */
export const ORDER_CREATE_NO_ITEMS_MESSAGE =
  'Buyurtmada kamida bitta mahsulot bo‘lishi kerak';

/** Mavjud (IDG1z5y9) matn — o'zgartirilmadi, testlar va frontend shunga tayanadi. */
export const ORDER_CREATE_ITEM_QUANTITY_MESSAGE =
  'Mahsulot miqdori (quantity) kamida 1 va butun son bo‘lishi kerak';

export const ORDER_CREATE_NO_DISTRICT_MESSAGE =
  'Buyurtma uchun tuman tanlanmagan';

/** Bo'sh bo'lmagan id (satr yoki son) → trim qilingan satr; aks holda `null`. */
export function orderCreateIdOrNull(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id ? id : null;
}

/**
 * Mahsulot qatorlari muammosi — xato matni yoki `null` (hammasi joyida).
 * Bo'sh / massiv emas / obyekt bo'lmagan qator → «kamida bitta mahsulot»;
 * miqdori berilgan, lekin butun son ≥ 1 emas (0, manfiy, kasr, matn) →
 * miqdor xatosi. Miqdor berilmagan qator — 1 (order-service sukuti).
 */
export function orderCreateItemsProblem(items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) {
    return ORDER_CREATE_NO_ITEMS_MESSAGE;
  }
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return ORDER_CREATE_NO_ITEMS_MESSAGE;
    }
    const quantity = (item as { quantity?: unknown }).quantity;
    if (quantity === undefined || quantity === null) continue;
    const parsed = typeof quantity === 'number' ? quantity : Number(quantity);
    if (
      (typeof quantity !== 'number' && typeof quantity !== 'string') ||
      (typeof quantity === 'string' && quantity.trim() === '') ||
      !Number.isInteger(parsed) ||
      parsed < 1
    ) {
      return ORDER_CREATE_ITEM_QUANTITY_MESSAGE;
    }
  }
  return null;
}
