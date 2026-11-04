import {
  escapeTelegramHtml,
  formatOrderNumber,
  TASHKENT_OFFSET_MINUTES,
} from '@app/common';
import { formatSum } from '../courier/courier-cards';

/** Almashtirishda eski buyurtma nomzodi (gateway `AiReplacementCandidate`). */
export interface AiReplacementCandidate {
  id?: string | null;
  order_number?: string | null;
  created_at?: string | number | null;
  items?: string | null;
  total_price?: number | null;
}

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
  /**
   * Almashtirish qidiruvi natijasi (gateway): `found` — bog'landi,
   * `not_found` — oddiy buyurtma, `taken` / `unavailable` — botdan
   * yaratilmaydi. Yo'q bo'lsa (deploy'dan oldingi draft) — `unavailable`.
   */
  replacement_lookup?: string | null;
  /** Almashtirish: gateway avtomatik tanlagan eski buyurtma (eng yangisi). */
  replaced_order_id?: string | null;
  replacement_candidates?: AiReplacementCandidate[];
  /** Barcha mos eski buyurtmalar soni (kartada "yana N ta"). */
  replacement_candidates_total?: number | null;
  operator?: string | null;
}

/** Bot "✅ Yaratish" tugmasida operator hal qiladigan kamchiliklar. */
const RESOLVED_BY_CONFIRM = new Set(['price_confirm', 'item_unresolved']);
/**
 * Eski buyurtma bog'langan almashtirishda narx so'ralmaydi (BeePost): bo'sh
 * narx — 0 (bepul almashtirish), kichik narx tasdiqsiz.
 */
const REPLACEMENT_PRICE_ISSUES = new Set(['price_missing', 'price_confirm']);

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
 * Bog'langan eski buyurtma id'si — faqat almashtirish preview'ida, gateway
 * `found` degan va id raqam bo'lsa (`POST /orders/ai-confirm`
 * `replaced_order_id` qoidasi).
 */
export function linkedReplacementId(order: AiPreviewOrder): string | null {
  if (order.is_replacement !== true) return null;
  if (order.replacement_lookup !== 'found') return null;
  const id = clip(order.replaced_order_id, 18);
  return /^\d{1,18}$/.test(id) ? id : null;
}

/**
 * Almashtirish holati: `linked` — eski buyurtma bog'langan; `plain` —
 * qidirildi, topilmadi (oddiy buyurtma); `blocked` — tekshirib bo'lmadi,
 * nomzodlar band yoki eski draft (natija kaliti yo'q) — botdan yaratilmaydi
 * (ilgarigi kabi kabinetda). Almashtirish bo'lmasa — `null`.
 */
type ReplacementState = 'linked' | 'plain' | 'blocked';

function replacementState(order: AiPreviewOrder): ReplacementState | null {
  if (order.is_replacement !== true) return null;
  if (linkedReplacementId(order)) return 'linked';
  return order.replacement_lookup === 'not_found' ? 'plain' : 'blocked';
}

const hasPrice = (price: unknown): price is number =>
  typeof price === 'number' && Number.isFinite(price) && price >= 0;

/**
 * Botdan yaratsa bo'ladimi: majburiy maydonlar bor va kamchiliklar faqat
 * "Yaratish" bosilishi bilan hal bo'ladiganlar (narxni ko'rib tasdiqlash,
 * katalogda yo'q mahsulot — nomi bilan, Elchida katalog shart emas).
 * Qolganlari (tuman, telefon, ism, …) — kabinetda tuzatiladi.
 * Almashtirish: eski buyurtma bog'langan bo'lsa narx bo'sh bo'lishi mumkin
 * (0 bilan yaratiladi); topilmagan bo'lsa — oddiy buyurtma kabi; tekshirib
 * bo'lmagan / band / eski draft — yo'q.
 */
export function isCreatable(order: AiPreviewOrder): boolean {
  const replacement = replacementState(order);
  if (replacement === 'blocked') return false;
  const issues = Array.isArray(order.issues) ? order.issues : [];
  const linked = replacement === 'linked';
  return Boolean(
    issues.every(
      (issue) =>
        RESOLVED_BY_CONFIRM.has(issue) ||
        (linked && REPLACEMENT_PRICE_ISSUES.has(issue)),
    ) &&
    clip(order.customer_name, 120) &&
    clip(order.phone_number, 40) &&
    /^\d{1,20}$/.test(String(order.district_id ?? '')) &&
    Array.isArray(order.items) &&
    order.items.length > 0 &&
    (hasPrice(order.total_price) ||
      (linked &&
        (order.total_price === null || order.total_price === undefined))) &&
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
  const replacedOrderId = linkedReplacementId(order);
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
    // Almashtirish (eski buyurtma bog'langan) narxsiz — narx YUBORILMAYDI:
    // gateway 0 qo'yadi (bepul, BeePost). 0 yuborilsa AI auditida operator
    // narxni tuzatgandek yozilardi (preview'da `null`).
    ...(hasPrice(order.total_price)
      ? { total_price: order.total_price }
      : replacedOrderId
        ? {}
        : { total_price: Number(order.total_price) }),
    ...(replacedOrderId ? { replaced_order_id: replacedOrderId } : {}),
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

/** dd.mm.yyyy (Toshkent, UTC+5) — ISO satr yoki epoch ms; bo'lmasa ''. */
function tashkentDate(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : value;
  const ms =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? /^\d+$/.test(raw)
          ? Number(raw)
          : Date.parse(raw)
        : Number.NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + TASHKENT_OFFSET_MINUTES * 60_000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/**
 * Almashtirish qatori (faqat `is_replacement`): bog'langan eski buyurtma,
 * "topilmadi — oddiy buyurtma" yoki "kabinetda yarating". Boshqa nomzod
 * tanlash — faqat kabinetda yaratishda (BeePost botida ham tanlash tugmasi
 * yo'q; bog'lanish yaratilgach o'zgarmaydi — shuning uchun ✅ bosmaslik).
 */
function replacementLine(order: AiPreviewOrder): string | null {
  const state = replacementState(order);
  if (!state) return null;
  if (state === 'plain') {
    return '🔄 Almashtirish — eski buyurtma topilmadi, oddiy buyurtma bo‘lib yaratiladi.';
  }
  if (state === 'blocked') {
    return order.replacement_lookup === 'taken'
      ? '🔄 Almashtirish — eski buyurtma shu xabardagi boshqa almashtirishga bog‘landi, buni kabinetda yarating.'
      : '🔄 Almashtirish — eski buyurtmani tekshirib bo‘lmadi, qayta yuboring yoki kabinetda yarating.';
  }
  const linkedId = linkedReplacementId(order) ?? '';
  const candidates = Array.isArray(order.replacement_candidates)
    ? order.replacement_candidates
    : [];
  const old = candidates.find((c) => clip(c?.id, 18) === linkedId);
  const number =
    clip(old?.order_number, 30) || formatOrderNumber(linkedId) || linkedId;
  const details = [tashkentDate(old?.created_at), clip(old?.items, 80)]
    .filter(Boolean)
    .join(', ');
  const total = Math.max(
    candidates.length,
    Math.trunc(Number(order.replacement_candidates_total) || 0),
  );
  const others = total - 1;
  return (
    `🔄 Almashtirish — eski №${escapeTelegramHtml(number)}` +
    `${details ? ` (${escapeTelegramHtml(details)})` : ''} o‘rniga. ` +
    'Kuryer eskisini olib keladi.' +
    (others > 0
      ? ` (yana ${others} ta — boshqasi kerak bo‘lsa «✅ Yaratish» ni bosmang, kabinetda yarating)`
      : '')
  );
}

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
    const linked = replacementState(order) === 'linked';
    const issues = (order.issues ?? [])
      .filter((issue) => !(linked && REPLACEMENT_PRICE_ISSUES.has(issue)))
      .map((issue) => AI_ISSUE_LABELS[issue] ?? issue)
      .join(', ');
    const price =
      typeof order.total_price === 'number'
        ? escapeTelegramHtml(formatSum(order.total_price))
        : linked
          ? `${escapeTelegramHtml(formatSum(0))} (almashtirish)`
          : '—';
    const replacement = replacementLine(order);
    lines.push(
      '',
      `<b>${order.index + 1})</b> ${isCreatable(order) ? '🟢' : '🟠'} 👤 ${html(order.customer_name) || '—'}, 📞 ${html(order.phone_number, 40) || '—'}`,
      `📍 ${escapeTelegramHtml(place || '—')}${clip(order.address, 120) ? ` — ${html(order.address)}` : ''}`,
      `📦 ${items || '—'}`,
      `💰 ${price} · ${order.where_deliver === 'center' ? '🏢 markazga' : '🏠 manzilga'}`,
      ...(replacement ? [replacement] : []),
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
