/**
 * (MWYaqprw #5) Skan natijasida kuryer tuman va mijozni DARHOL ko'rsin —
 * ilgari `POST /orders/scan-assign` faqat `{ order_id, post_id }` qaytarardi
 * va kuryer alohida `GET /orders/:id` ochishi kerak edi.
 *
 * Kirish — `order.find_by_qr_light` (yoki to'liq `find_by_qr_enriched`)
 * javobi; chiqish — skaner ekraniga yetarli ixcham obyekt. Tarif/ulush kabi
 * maydonlar KIRMAYDI (faqat oq ro'yxat).
 */
export interface ScanOrderSummary {
  id: string;
  order_number: string | null;
  status: string | null;
  total_price: number | null;
  address: string | null;
  district: string | null;
  region: string | null;
  market: string | null;
  customer: { name: string | null; phone_number: string | null } | null;
  /** T8: maxsus belgilar (mo'rt, suyuqlik …); yo'q / massiv emas — []. */
  special_categories: string[];
}

type Row = Record<string, unknown>;

const asRow = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : null;

const nameOf = (value: unknown): string | null => text(asRow(value)?.name);

/** `{data:{data:row}}` / `{data:row}` / `row` — qaysi biri `id` ga ega bo'lsa. */
function unwrapOrder(payload: unknown): Row | null {
  const top = asRow(payload);
  const data = asRow(top?.data);
  for (const candidate of [asRow(data?.data), data, top]) {
    if (candidate && text(candidate.id)) return candidate;
  }
  return null;
}

export function scanOrderSummary(payload: unknown): ScanOrderSummary | null {
  const order = unwrapOrder(payload);
  if (!order) return null;
  const customer = asRow(order.customer);
  const price = Number(order.total_price);
  return {
    id: text(order.id) as string,
    order_number: text(order.order_number),
    status: text(order.status),
    total_price: Number.isFinite(price) ? price : null,
    address: text(order.address),
    district: nameOf(order.district),
    region: nameOf(order.region),
    market: nameOf(order.market),
    customer: customer
      ? {
          name: text(customer.name),
          phone_number: text(customer.phone_number),
        }
      : null,
    special_categories: Array.isArray(order.special_categories)
      ? order.special_categories.filter(
          (code): code is string => typeof code === 'string',
        )
      : [],
  };
}
