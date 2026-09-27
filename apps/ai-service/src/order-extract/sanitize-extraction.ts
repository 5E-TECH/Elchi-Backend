import { isJunkRawOrder, type RawOrderExtraction } from '@app/common';

/**
 * Model chiqishini (Claude JSON) `RawOrderExtraction[]` ga keltiradi —
 * BeePost `rawToDraft` (ai-order.service.ts@origin/dev:573-614) porti.
 *
 * ⚠️ Model chiqishi — ISHONCHSIZ ma'lumot (32fNx0Ci): sxema API darajasida
 * majburlansa ham, prompt-injection yoki gallyutsinatsiya bilan kelgan
 * qiymat bu yerda yana tekshiriladi:
 * - faqat 13 ta ruxsat etilgan maydon qoladi — `district_id`, `operator_id`
 *   kabi begona kalitlar TASHLANADI (ID hech qachon modeldan olinmaydi);
 * - `total_price` faqat chekli va > 0 bo'lsa (yaxlitlanadi), aks holda null
 *   (0 ham, manfiy ham "narx aytilmagan" — 0 EMAS);
 * - `where_deliver` faqat aynan 'center' | 'address', boshqasi null;
 * - `operator` — '#' olib tashlanadi, faqat matn (operator_id'ga HECH QACHON
 *   bog'lanmaydi);
 * - `quantity` butun va ≥ 1 bo'lmasa 1. 1000 dan kattasi ATAYLAB o'zgartirilmaydi
 *   — ai-confirm DTO (`@Max(1000)`) uni ko'rinadigan tarzda to'xtatadi,
 *   jimgina 1000 ga kesib qo'yish esa noto'g'ri buyurtma yaratardi.
 * - Telefon HAM, nomli mahsulot HAM yo'q element (axlat) tashlanadi.
 *
 * Kirish: `{orders: [...]}` (Claude javobi) yoki to'g'ridan-to'g'ri massiv.
 * Sof funksiya — kirishni o'zgartirmaydi, hech qachon throw qilmaydi.
 */
export function sanitizeExtraction(raw: unknown): RawOrderExtraction[] {
  const list = extractOrderList(raw);
  const out: RawOrderExtraction[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const order = sanitizeOrder(entry);
    if (isJunkRawOrder(order)) continue;
    out.push(order);
  }
  return out;
}

function extractOrderList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.orders)) return raw.orders;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Satr trim qilinadi; satr bo'lmasa yoki bo'sh qolsa — null. */
function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function cleanItems(value: unknown): RawOrderExtraction['items'] {
  if (!Array.isArray(value)) return [];
  const items: RawOrderExtraction['items'] = [];
  for (const it of value) {
    if (!isRecord(it)) continue;
    const name = cleanString(it.name);
    if (name === null) continue;
    const q = it.quantity;
    // ⚠️ >1000 o'zgartirilmaydi — DTO to'xtatadi (yuqoridagi izoh).
    const quantity =
      typeof q === 'number' && Number.isInteger(q) && q >= 1 ? q : 1;
    items.push({ name, quantity });
  }
  return items;
}

function cleanPrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function cleanWhereDeliver(
  value: unknown,
): RawOrderExtraction['where_deliver'] {
  return value === 'center' || value === 'address' ? value : null;
}

function cleanOperator(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return cleanString(value.trim().replace(/^#+/, ''));
}

/** Oq ro'yxat — faqat shu 13 maydon ko'chiriladi, qolgani tashlanadi. */
function sanitizeOrder(o: Record<string, unknown>): RawOrderExtraction {
  return {
    customer_name: cleanString(o.customer_name),
    phone_number: cleanString(o.phone_number),
    extra_number: cleanString(o.extra_number),
    region_name: cleanString(o.region_name),
    district_name: cleanString(o.district_name),
    address: cleanString(o.address),
    full_address: cleanString(o.full_address),
    items: cleanItems(o.items),
    total_price: cleanPrice(o.total_price),
    comment: cleanString(o.comment),
    where_deliver: cleanWhereDeliver(o.where_deliver),
    is_replacement: o.is_replacement === true,
    operator: cleanOperator(o.operator),
  };
}
