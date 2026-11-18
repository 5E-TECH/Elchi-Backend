import { AI_MAX_CANDIDATES, escapeTelegramHtml } from '@app/common';
import type {
  AiPreviewItem,
  AiPreviewOrder,
  AiProductOption,
} from './ai-preview';

/**
 * Katalogda topilmagan mahsulotni botda tanlash (BeePost
 * `MAX_CANDIDATE_BUTTONS`): AI nomzodlari, «🔎 Qidirish» natijalari yoki
 * «Nomi bilan qoldirish». Tugma payload'ida faqat indekslar (`o` — preview
 * `index`, `i` — item o'rni, `k` — ro'yxatdagi o'rin) — nomlar qoralamada
 * (`telegram_ai_drafts.orders`), callback_data 64 baytdan oshmaydi.
 */

/** Ro'yxat manbai: `c` — AI nomzodlari, `s` — qidiruv natijalari. */
export type AiPickSource = 'c' | 's';

/** Preview kartasida «❓ … — tanlash» tugmalari soni (klaviatura cho'zilmasin). */
export const AI_PICK_MAX_ENTRIES = 5;
/** Qidiruv so'rovi uzunligi (belgi). */
export const AI_SEARCH_MIN_CHARS = 2;
export const AI_SEARCH_MAX_CHARS = 100;

export const AI_SEARCH_PROMPT_TEXT =
  '🔎 Mahsulot nomini yozib yuboring (masalan: «Atir 50ml»). Bekor qilish — «↩️ Orqaga».';
export const AI_SEARCH_BAD_QUERY_TEXT = `✏️ Mahsulot nomini ${AI_SEARCH_MIN_CHARS}–${AI_SEARCH_MAX_CHARS} belgida yozing.`;
export const AI_SEARCH_FAILED_TEXT =
  '❌ Qidirib bo‘lmadi — birozdan so‘ng qayta yozib ko‘ring.';

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Katalog mahsulot id'si (preview / my-products) — bo'sh yoki g'alati emas. */
const validId = (value: unknown): string | null => {
  const id = clip(value, 40);
  return /^[0-9A-Za-z_-]{1,40}$/.test(id) ? id : null;
};

/** `{ id, name }` ro'yxati — faqat to'g'ri shakldagilar, ko'pi bilan 5 ta. */
export function productOptions(value: unknown): AiProductOption[] {
  if (!Array.isArray(value)) return [];
  const out: AiProductOption[] = [];
  for (const raw of value) {
    const entry = raw as { id?: unknown; name?: unknown } | null;
    const id = validId(entry?.id);
    const name = clip(entry?.name, 255);
    if (!id || !name || out.some((o) => o.id === id)) continue;
    out.push({ id, name });
    if (out.length >= AI_MAX_CANDIDATES) break;
  }
  return out;
}

/** Operator hal qilishi kerak bo'lgan item: katalog id'si yo'q, nomi bilan qoldirilmagan. */
export const needsPick = (item: AiPreviewItem | null | undefined): boolean =>
  Boolean(item) && !item!.product_id && item!.keep_name !== true;

/** Tanlash kerak bo'lgan itemlar (preview tartibida), kartadagi tugmalar uchun. */
export function pickEntries(
  orders: AiPreviewOrder[],
): Array<{ order: AiPreviewOrder; itemIndex: number; item: AiPreviewItem }> {
  const out: Array<{
    order: AiPreviewOrder;
    itemIndex: number;
    item: AiPreviewItem;
  }> = [];
  for (const order of orders) {
    (order.items ?? []).forEach((item, itemIndex) => {
      if (needsPick(item)) out.push({ order, itemIndex, item });
    });
  }
  return out.slice(0, AI_PICK_MAX_ENTRIES);
}

/** Kartadagi tugma matni: «❓ 1) Atir 50ml — tanlash». */
export function pickEntryLabel(
  order: AiPreviewOrder,
  item: AiPreviewItem,
  multi: boolean,
): string {
  return `❓ ${multi ? `${order.index + 1}) ` : ''}${clip(item.name, 30) || 'Mahsulot'} — tanlash`;
}

/** Tanlash oynasining matni (HTML). */
export function pickerText(
  order: AiPreviewOrder,
  item: AiPreviewItem,
  source: AiPickSource,
  options: AiProductOption[],
  query?: string,
): string {
  const quantity = Math.max(1, Math.trunc(Number(item.quantity ?? 1)));
  const head = `📦 <b>${order.index + 1}-buyurtma</b>: «${escapeTelegramHtml(clip(item.name, 80) || '—')}» ×${quantity} — katalogda aniq topilmadi.`;
  if (source === 's') {
    const q = clip(query, 60);
    return [
      head,
      '',
      options.length
        ? q
          ? `🔎 «${escapeTelegramHtml(q)}» bo‘yicha topildi — mosini tanlang:`
          : '🔎 Oxirgi qidiruv natijalari — mosini tanlang:'
        : `🤷 «${escapeTelegramHtml(clip(query, 60))}» bo‘yicha mahsulot topilmadi — boshqa nom yozib yuboring yoki nomi bilan qoldiring.`,
    ].join('\n');
  }
  return [
    head,
    '',
    options.length
      ? 'Katalogdan mosini tanlang, «🔎 Qidirish» yoki «📝 Nomi bilan qoldirish».'
      : 'Katalogda o‘xshash mahsulot yo‘q — «🔎 Qidirish» yoki «📝 Nomi bilan qoldirish».',
  ].join('\n');
}

/** Tanlash tugmasining matni (oddiy matn, HTML emas). */
export const optionLabel = (option: AiProductOption): string =>
  `✅ ${clip(option.name, 50)}`;

/**
 * Qoralamadagi item (preview `index` + item o'rni). Topilmasa — null
 * (eskirgan tugma / boshqa qoralama).
 */
export function findItem(
  orders: AiPreviewOrder[],
  orderIndex: unknown,
  itemIndex: unknown,
): { order: AiPreviewOrder; item: AiPreviewItem } | null {
  if (!Number.isInteger(orderIndex) || !Number.isInteger(itemIndex)) {
    return null;
  }
  const order = orders.find((o) => o.index === orderIndex);
  const item = order?.items?.[itemIndex as number];
  return order && item ? { order, item } : null;
}

/** Itemlarning hammasi hal bo'lsa `item_unresolved` kamchiligi olib tashlanadi. */
function syncUnresolvedIssue(order: AiPreviewOrder): AiPreviewOrder {
  const pending = (order.items ?? []).some((item) => !item.product_id);
  if (pending || !Array.isArray(order.issues)) return order;
  return {
    ...order,
    issues: order.issues.filter((issue) => issue !== 'item_unresolved'),
  };
}

/** Bitta itemni o'zgartirib yangi `orders` qaytaradi (asl massiv o'zgarmaydi). */
function patchItem(
  orders: AiPreviewOrder[],
  orderIndex: number,
  itemIndex: number,
  patch: (item: AiPreviewItem) => AiPreviewItem,
): AiPreviewOrder[] {
  return orders.map((order) => {
    if (order.index !== orderIndex) return order;
    const items = (order.items ?? []).map((item, i) =>
      i === itemIndex ? patch(item) : item,
    );
    return syncUnresolvedIssue({ ...order, items });
  });
}

/**
 * Ro'yxatdan (`c` / `s`) `k`-mahsulot tanlandi: `product_id` + ko'rsatish
 * nomi qo'yiladi. Ro'yxatda yo'q bo'lsa yoki o'rindagi mahsulot tugmadagi
 * `pid` emas (eski qidiruv xabari — ro'yxat almashgan) — null (o'zgarish
 * yo'q).
 */
export function applyProductPick(
  orders: AiPreviewOrder[],
  orderIndex: unknown,
  itemIndex: unknown,
  source: unknown,
  k: unknown,
  pid: unknown,
): AiPreviewOrder[] | null {
  const found = findItem(orders, orderIndex, itemIndex);
  if (!found || !Number.isInteger(k)) return null;
  const list = productOptions(
    source === 's' ? found.item.search_results : found.item.candidates,
  );
  const option = list[k as number];
  if (!option || typeof pid !== 'string' || option.id !== pid) return null;
  return patchItem(
    orders,
    orderIndex as number,
    itemIndex as number,
    (item) => {
      const next: AiPreviewItem = {
        ...item,
        product_id: option.id,
        resolved_name: option.name,
        unresolved: false,
      };
      delete next.keep_name;
      delete next.search_results;
      return next;
    },
  );
}

/** «📝 Nomi bilan qoldirish» — katalogsiz (allow_unlisted_product) yaratiladi. */
export function applyKeepName(
  orders: AiPreviewOrder[],
  orderIndex: unknown,
  itemIndex: unknown,
): AiPreviewOrder[] | null {
  if (!findItem(orders, orderIndex, itemIndex)) return null;
  return patchItem(
    orders,
    orderIndex as number,
    itemIndex as number,
    (item) => {
      const next: AiPreviewItem = { ...item, keep_name: true };
      delete next.search_results;
      return next;
    },
  );
}

/** Qidiruv natijalari itemga yoziladi (keyingi «✅ …» bosish shu ro'yxatdan). */
export function applySearchResults(
  orders: AiPreviewOrder[],
  orderIndex: number,
  itemIndex: number,
  results: AiProductOption[],
): AiPreviewOrder[] {
  return patchItem(orders, orderIndex, itemIndex, (item) => ({
    ...item,
    search_results: results,
  }));
}

/**
 * `GET /product/my-products` javobi → `{ id, name }` (ko'pi bilan 5).
 * Gateway katalog javobini o'rasa ham (`data.data`) o'qiladi.
 */
export function productsFromSearch(body: unknown): AiProductOption[] {
  const b = body as { data?: unknown } | null;
  const inner = (b?.data as { data?: unknown } | null)?.data;
  return productOptions(Array.isArray(b?.data) ? b?.data : inner);
}
