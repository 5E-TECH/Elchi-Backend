import { escapeTelegramHtml } from '@app/common';
import { formatSum } from '../courier/courier-cards';

/**
 * `POST /orders/ai-parse` javobidagi bitta preview (order-service
 * `AiOrderPreview` shartnomasi — faqat bot o'qiydigan maydonlar).
 */
export interface AiPreviewOrder {
  index: number;
  ready?: boolean;
  issues?: string[];
  customer_name?: string | null;
  phone_number?: string | null;
  extra_number?: string | null;
  region_id?: string | null;
  region_name?: string | null;
  district_id?: string | null;
  district_name?: string | null;
  address?: string | null;
  items?: Array<{
    name?: string | null;
    quantity?: number | null;
    product_id?: string | null;
    resolved_name?: string | null;
    unresolved?: boolean;
  }>;
  total_price?: number | null;
  where_deliver?: 'center' | 'address';
  comment?: string | null;
  is_replacement?: boolean;
  operator?: string | null;
}

/** Bot "✅ Yaratish" tugmasida operator hal qiladigan kamchiliklar. */
const RESOLVED_BY_CONFIRM = new Set(['price_confirm', 'item_unresolved']);

/** Kamchilik kalitlari → bot UI matni (frontend i18n bilan bir xil ma'no). */
export const AI_ISSUE_LABELS: Record<string, string> = {
  name_missing: "mijoz ismi yo'q",
  phone_invalid: "telefon noto'g'ri",
  region_missing: 'viloyat aniqlanmadi',
  district_missing: 'tuman aniqlanmadi',
  price_missing: "narx yo'q",
  price_confirm: 'narxni tekshiring',
  items_missing: "mahsulot yo'q",
  item_unresolved: 'mahsulot katalogda topilmadi — nomi bilan yaratiladi',
};

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const html = (value: unknown, max = 120) =>
  escapeTelegramHtml(clip(value, max));

/**
 * Botdan yaratsa bo'ladimi: majburiy maydonlar bor va kamchiliklar faqat
 * "Yaratish" bosilishi bilan hal bo'ladiganlar (narxni ko'rib tasdiqlash,
 * katalogda yo'q mahsulot — nomi bilan, Elchida katalog shart emas).
 * Qolganlari (tuman, telefon, ism, …) — kabinetda tuzatiladi.
 */
export function isCreatable(order: AiPreviewOrder): boolean {
  const issues = Array.isArray(order.issues) ? order.issues : [];
  return Boolean(
    issues.every((issue) => RESOLVED_BY_CONFIRM.has(issue)) &&
    !order.is_replacement &&
    clip(order.customer_name, 120) &&
    clip(order.phone_number, 40) &&
    /^\d{1,20}$/.test(String(order.district_id ?? '')) &&
    Array.isArray(order.items) &&
    order.items.length > 0 &&
    typeof order.total_price === 'number' &&
    Number.isFinite(order.total_price) &&
    order.total_price >= 0 &&
    (order.where_deliver === 'center' || order.where_deliver === 'address'),
  );
}

/** Preview → `POST /orders/ai-confirm` buyurtmasi (AiConfirmOrderDto). */
export function toConfirmOrder(
  order: AiPreviewOrder,
  aiDraftId: string | null,
) {
  const district = String(order.district_id);
  const address = clip(order.address, 255);
  return {
    customer: {
      name: clip(order.customer_name, 120),
      phone_number: clip(order.phone_number, 40),
      district_id: district,
      ...(clip(order.extra_number, 40)
        ? { extra_number: clip(order.extra_number, 40) }
        : {}),
      ...(address ? { address } : {}),
    },
    district_id: district,
    ...(aiDraftId ? { draft_id: aiDraftId } : {}),
    ai_item_index: order.index,
    items: (order.items ?? []).map((item) => {
      const quantity = Math.max(1, Math.trunc(Number(item.quantity ?? 1)));
      return item.product_id
        ? { product_id: String(item.product_id), quantity }
        : {
            product_name: clip(item.name, 255) || 'Mahsulot',
            allow_unlisted_product: true,
            quantity,
          };
    }),
    total_price: Number(order.total_price),
    where_deliver: order.where_deliver,
    ...(address ? { address } : {}),
    ...(clip(order.comment, 1000)
      ? { comment: clip(order.comment, 1000) }
      : {}),
    ...(clip(order.operator, 100)
      ? { operator: clip(order.operator, 100) }
      : {}),
  };
}

const PREVIEW_MAX_ORDERS = 10;

/** Preview kartasi (shaxsiy chat — operatorning o'z buyurtmalari, PII bor). */
export function aiPreviewText(orders: AiPreviewOrder[]): string {
  const creatable = orders.filter(isCreatable).length;
  const lines = [
    `🤖 <b>AI ${orders.length} ta buyurtma topdi</b> — tekshiring:`,
  ];
  for (const order of orders.slice(0, PREVIEW_MAX_ORDERS)) {
    const place = [order.region_name, order.district_name]
      .map((part) => clip(part, 60))
      .filter(Boolean)
      .join(', ');
    const items = (order.items ?? [])
      .slice(0, 8)
      .map(
        (item) =>
          `${html(item.resolved_name || item.name, 60)} ×${Math.max(1, Math.trunc(Number(item.quantity ?? 1)))}`,
      )
      .join('; ');
    const issues = (order.issues ?? [])
      .map((issue) => AI_ISSUE_LABELS[issue] ?? issue)
      .join(', ');
    lines.push(
      '',
      `<b>${order.index + 1})</b> ${isCreatable(order) ? '🟢' : '🟠'} 👤 ${html(order.customer_name) || '—'}, 📞 ${html(order.phone_number, 40) || '—'}`,
      `📍 ${escapeTelegramHtml(place || '—')}${clip(order.address, 120) ? ` — ${html(order.address)}` : ''}`,
      `📦 ${items || '—'}`,
      `💰 ${typeof order.total_price === 'number' ? escapeTelegramHtml(formatSum(order.total_price)) : '—'} · ${order.where_deliver === 'center' ? '🏢 markazga' : '🏠 manzilga'}`,
      ...(issues ? [`⚠️ ${escapeTelegramHtml(issues)}`] : []),
    );
  }
  if (orders.length > PREVIEW_MAX_ORDERS) {
    lines.push(
      '',
      `… yana ${orders.length - PREVIEW_MAX_ORDERS} ta (kabinetda).`,
    );
  }
  lines.push(
    '',
    creatable
      ? `✅ «Yaratish» — ${creatable} ta tayyor buyurtma yaratiladi. 🟠 belgilisini kabinetda tuzating.`
      : '🟠 Tayyor buyurtma yo‘q — matnni tuzatib qayta yuboring yoki kabinetda yarating.',
  );
  let text = '';
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > 3900) return `${text}\n…`;
    text = next;
  }
  return text;
}
