import {
  AI_BLOCKING_CHECK_CODES,
  escapeTelegramHtml,
  formatOrderNumber,
  TASHKENT_OFFSET_MINUTES,
} from '@app/common';
import { createHash } from 'node:crypto';
import { formatSum } from '../courier/courier-cards';
import { validOperatorId } from './ai-order-operator';

/** ai-confirm'ga odam yo'lidan qo'shiladigan maydonlar (preview'dan EMAS). */
export interface ConfirmExtra {
  operator_id?: string | null;
  operator_phone?: string | null;
}

/** Almashtirishda eski buyurtma nomzodi (gateway `AiReplacementCandidate`). */
export interface AiReplacementCandidate {
  id?: string | null;
  order_number?: string | null;
  created_at?: string | number | null;
  items?: string | null;
  total_price?: number | null;
}

/** Katalog mahsuloti (AI nomzodi yoki «🔎 Qidirish» natijasi). */
export interface AiProductOption {
  id: string;
  name: string;
}

/** Preview'dagi bitta mahsulot (order-service `AiPreviewItem`). */
export interface AiPreviewItem {
  name?: string | null;
  quantity?: number | null;
  product_id?: string | null;
  resolved_name?: string | null;
  unresolved?: boolean;
  /** Katalogdan mos kelishi mumkin bo'lganlar (≤5) — operator tanlaydi. */
  candidates?: AiProductOption[] | null;
  /**
   * BOT ICHKI maydoni: operator «📝 Nomi bilan qoldirish» ni bosdi —
   * katalogsiz (`allow_unlisted_product`) yaratiladi, tanlash so'ralmaydi.
   */
  keep_name?: boolean;
  /** BOT ICHKI maydoni: oxirgi «🔎 Qidirish» natijalari (≤5). */
  search_results?: AiProductOption[] | null;
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
  items?: AiPreviewItem[];
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
  /** P1-7: tuman qanday aniqlangani — bot faqat `ai_text` ni ko'rsatadi. */
  district_match?: { method?: string | null; ai_text?: string | null } | null;
  /**
   * P1-7: AI tekshiruvlari. `district_low_confidence` va `price_check` —
   * BLOKLOVCHI (yaratishdan oldin qayta tasdiq + `ack_checks`), qolganlari
   * yumshoq ogohlantirish. Noma'lum kod e'tiborsiz qoldiriladi.
   */
  checks?: AiPreviewCheck[];
  /**
   * (AI ack B3) BOT ICHKI maydoni (gateway'dan kelmaydi): operator
   * «Baribir yaratamanmi?» oynasida AYNAN ko'rgan va «✅ Ha, yaratish» bilan
   * tasdiqlagan bloklovchi kodlar. ai-confirm `ack_checks` faqat shundan —
   * ko'rsatilmagan ogohlantirish hech qachon avtomatik tasdiqlanmaydi.
   */
  acked_checks?: string[];
  /** Tuman aniqlanmadi — nomzodlar (≤5, order-service `district_candidates`). */
  district_candidates?: AiDistrictCandidate[] | null;
  /**
   * BOT ICHKI maydoni: operator tumanni birinchi marta o'zgartirganda AI
   * taklif qilgan `district_id` (yo'q bo'lsa null). `undefined` — tuman
   * tahrirlanmagan. AI ack: tuman shundan farq qilsa
   * `district_low_confidence` tasdiq so'ramaydi (server ham shunday).
   */
  ai_district_id?: string | null;
  /** BOT ICHKI maydoni: viloyat tumanlari ro'yxati (`GET /district`). */
  district_options?: AiDistrictOption[] | null;
  /** BOT ICHKI maydoni: viloyatdagi tumanlar soni (ro'yxat 40 bilan cheklangan). */
  district_options_total?: number;
  /**
   * BOT ICHKI maydoni: shu buyurtma ai-confirm'ga YUBORILDI, lekin natija
   * noma'lum (timeout / tarmoq / 5xx / tushunarsiz javob, qotgan
   * `creating`) — epoch ms. Server kaliti `ai:<market>:<draft>:<index>`
   * muddatsiz va yukni solishtirmaydi: keyingi «✅» birinchi urinish
   * natijasini qaytaradi, shuning uchun botda tuzatish YOPILADI.
   */
  confirm_attempted_at?: number;
  /** BOT ICHKI maydoni: o'sha urinishda yuborilgan buyurtma izi (sha256). */
  confirm_fp?: string;
  /**
   * BOT ICHKI maydoni: urinishga JAVOB keldi va shu buyurtma YARATILGAN
   * (qolganlari qayta urinishli) — buyurtma id'si. `confirm_attempted_at`
   * bilan birga: tuzatish yopiq, lekin «Javob kelmadi» emas.
   */
  confirm_order_id?: string;
}

/** order-service `AiDistrictCandidate`: `label` = "<viloyat>, <tuman>". */
export interface AiDistrictCandidate {
  id?: string | null;
  label?: string | null;
  region_name?: string | null;
}

/** Botda tanlanadigan tuman. */
export interface AiDistrictOption {
  id: string;
  name: string;
  region_name?: string | null;
}

/** order-service `AiCheck` — bot o'qiydigan maydonlar. */
export interface AiPreviewCheck {
  code?: string | null;
  kind?: string | null;
  mentions?: number[] | null;
  item_index?: number | null;
  item_indexes?: number[] | null;
  other_index?: number | null;
}

const BLOCKING_CODES: ReadonlySet<string> = new Set(AI_BLOCKING_CHECK_CODES);

/**
 * Operator tumanni botda AI taklifidan BOSHQASIGA o'zgartirdimi. Server
 * `edited_fields` (AI snapshot `district_id` ≠ tasdiqlangan) bilan bir xil:
 * o'sha tumanni qayta tanlash — tahrir emas.
 */
export function districtEdited(order: AiPreviewOrder): boolean {
  return (
    order.ai_district_id !== undefined &&
    String(order.ai_district_id ?? '') !== String(order.district_id ?? '')
  );
}

/**
 * Amaldagi AI tekshiruvlari: operator tegishli maydonni o'zi tuzatgan
 * bo'lsa bloklovchi kod taalluqli emas (`AI_CHECK_EXEMPT_BY_EDIT`: tuman
 * o'zgardi → `district_low_confidence` yo'q).
 */
export function activeChecks(order: AiPreviewOrder): AiPreviewCheck[] {
  const checks = Array.isArray(order.checks) ? order.checks : [];
  return districtEdited(order)
    ? checks.filter((check) => check?.code !== 'district_low_confidence')
    : checks;
}

/**
 * Preview'dagi bloklovchi tekshiruv kodlari (takrorsiz, qat'iy tartibda) —
 * ai-confirm `ack_checks` ga AYNAN shular yuboriladi.
 */
export function blockingCheckCodes(order: AiPreviewOrder): string[] {
  const codes = new Set(
    activeChecks(order)
      .map((check) => (typeof check?.code === 'string' ? check.code : ''))
      .filter((code) => BLOCKING_CODES.has(code)),
  );
  return AI_BLOCKING_CHECK_CODES.filter((code) => codes.has(code));
}

/** (AI ack B3) Operator tasdiqlagan bloklovchi kodlar (qat'iy tartibda). */
export function ackedCodes(order: AiPreviewOrder): string[] {
  const acked = new Set(
    Array.isArray(order.acked_checks) ? order.acked_checks : [],
  );
  return AI_BLOCKING_CHECK_CODES.filter((code) => acked.has(code));
}

/**
 * (AI ack B3) Preview'dagi bloklovchi kodlarning HAMMASI operator
 * tomonidan tasdiqlanganmi (ko'rsatilgan oynada). Kodsiz buyurtma — ha.
 */
export function isFullyAcked(order: AiPreviewOrder): boolean {
  const acked = new Set(ackedCodes(order));
  return blockingCheckCodes(order).every((code) => acked.has(code));
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
  /**
   * ODAM tanlovi / aktor profili (preview'dan EMAS): `operator_id` — market
   * «🎧 Operator» da tanlagan; `operator_phone` — profil raqami (kerak
   * bo'lsa). Model chiqishi bu maydonlarni hech qachon bera olmaydi.
   */
  extra: ConfirmExtra = {},
) {
  const operatorId = validOperatorId(extra.operator_id);
  const operatorPhone = /^\+998\d{9}$/.test(String(extra.operator_phone ?? ''))
    ? String(extra.operator_phone)
    : null;
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
    // AI ack (B3): faqat operator «Baribir yaratamanmi?» oynasida KO'RGAN va
    // tasdiqlagan kodlar (`acked_checks`). Yo'q bo'lsa maydon yuborilmaydi.
    ...(ackedCodes(order).length ? { ack_checks: ackedCodes(order) } : {}),
    where_deliver: order.where_deliver,
    ...(address ? { address } : {}),
    ...(clip(order.comment, 1000)
      ? { comment: clip(order.comment, 1000) }
      : {}),
    ...(clip(order.operator, 100)
      ? { operator: clip(order.operator, 100) }
      : {}),
    ...(operatorId ? { operator_id: operatorId } : {}),
    ...(operatorPhone ? { operator_phone: operatorPhone } : {}),
  };
}

/** Javobi noma'lum ai-confirm urinishi — kartadagi ogohlantirish. */
export const AI_CONFIRM_UNKNOWN_LINE =
  '⚠️ Javob kelmadi — avval «✅ Yaratish» bilan natijani tekshiring; tuzatish faqat kabinetda';
/** Takroriy javob (`idempotent_replay`) — buyurtma eski ma'lumot bilan. */
export const AI_EDITS_NOT_APPLIED_TEXT =
  "⚠️ Tuzatishlar qo'llanmadi — buyurtma avvalgi ma'lumot bilan yaratilgan, kabinetda tahrirlang";

/** Buyurtma natijasi noma'lum ai-confirm'ga yuborilganmi (botda tuzatish yopiq). */
export const confirmAttempted = (order: AiPreviewOrder | undefined): boolean =>
  typeof order?.confirm_attempted_at === 'number';

/**
 * ai-confirm'ga ketadigan buyurtma izi (`ack_checks` siz — tasdiq har
 * bosishda yangilanadi, ma'lumot emas). Takroriy javobda solishtiriladi.
 */
export function confirmFingerprint(
  order: AiPreviewOrder,
  extra: ConfirmExtra = {},
): string {
  // Odam tanlovi (operator) ham izga kiradi — tanlov o'zgarsa takroriy
  // javobda «tuzatishlar qo'llanmadi» ko'rinadi.
  const payload: Record<string, unknown> = toConfirmOrder(order, null, {
    operator_id: extra.operator_id,
  });
  delete payload.ack_checks;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** ai-confirm'ga AYNAN yuboriladiganlar: tayyor (🟢) va to'liq tasdiqlangan. */
export const confirmSendable = (orders: AiPreviewOrder[]): AiPreviewOrder[] =>
  orders.filter((order) => isCreatable(order) && isFullyAcked(order));

/**
 * Natijasi noma'lum urinish: YUBORILGAN buyurtmalarga belgi va iz
 * qo'yiladi (yuborilmaganlariga tegilmaydi). Birinchi urinish izi saqlanadi
 * — server shu birinchi yukni eslab qoladi.
 */
export function markConfirmAttempted(
  orders: AiPreviewOrder[],
  sent: AiPreviewOrder[],
  at: number,
  /** Urinishdagi odam tanlovi — izga kiradi (S1). */
  extra: ConfirmExtra = {},
  /** Javob kelgan va YARATILGAN buyurtmalar: preview `index` → order_id. */
  created: ReadonlyMap<number, string> = new Map(),
): AiPreviewOrder[] {
  const indexes = new Set(sent.map((order) => order.index));
  return orders.map((order) => {
    if (!indexes.has(order.index)) return order;
    const orderId = created.get(order.index);
    return {
      ...order,
      confirm_attempted_at: order.confirm_attempted_at ?? at,
      confirm_fp: order.confirm_fp ?? confirmFingerprint(order, extra),
      ...(orderId ? { confirm_order_id: orderId } : {}),
    };
  });
}

/** Belgi bor, lekin natija NOMA'LUM (javob kelmagan) — yaratilgani aniq emas. */
export const outcomeUnknown = (order: AiPreviewOrder | undefined): boolean =>
  confirmAttempted(order) && !order?.confirm_order_id;

/** Takroriy javob, lekin yuborilgan ma'lumot birinchi urinishdagidan farq qiladi. */
export const editedAfterAttempt = (
  order: AiPreviewOrder,
  extra: ConfirmExtra = {},
): boolean =>
  typeof order.confirm_fp === 'string' &&
  order.confirm_fp !== confirmFingerprint(order, extra);

/** Kartada ko‘rsatiladigan buyurtmalar (qolgani — «… yana N ta»). */
export const PREVIEW_MAX_ORDERS = 10;

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

/** Summa: «150 000» (so'msiz — qatorda ikki summa yonma-yon). */
const plainSum = (value: unknown): string =>
  formatSum(value).replace(/ so'm$/, '');

/**
 * AI tekshiruvlari → qisqa «⚠️» qatorlar (oddiy tilda). Bloklovchilari
 * avval. Noma'lum kod — qatorsiz.
 */
export function aiCheckLines(order: AiPreviewOrder): string[] {
  return checkLines(order, activeChecks(order));
}

function checkLines(order: AiPreviewOrder, checks: AiPreviewCheck[]): string[] {
  const has = (code: string) => checks.find((c) => c?.code === code);
  const lines: string[] = [];
  if (has('district_low_confidence')) {
    const aiText = clip(order.district_match?.ai_text, 60);
    lines.push(
      aiText
        ? `⚠️ Tuman aniq emas: AI «${escapeTelegramHtml(aiText)}» deb o‘qidi — tekshiring`
        : '⚠️ Tuman aniq emas — tekshiring',
    );
  }
  const price = has('price_check');
  if (price) {
    const mentions = (Array.isArray(price.mentions) ? price.mentions : [])
      .filter((m) => typeof m === 'number' && Number.isFinite(m))
      .slice(0, 3)
      .map(plainSum);
    const total =
      typeof order.total_price === 'number' ? plainSum(order.total_price) : '—';
    lines.push(
      price.kind === 'too_high'
        ? `⚠️ Summa juda katta: ${escapeTelegramHtml(total)} — matnni tekshiring`
        : mentions.length
          ? `⚠️ Summa matndagidan farq qiladi: matnda ${escapeTelegramHtml(mentions.join(', '))}, AI ${escapeTelegramHtml(total)}`
          : `⚠️ Summa matndagidan farq qiladi: AI ${escapeTelegramHtml(total)} — tekshiring`,
    );
  }
  const qty = has('qty_check');
  if (qty) {
    const item = (order.items ?? [])[Number(qty.item_index)];
    lines.push(
      item
        ? `⚠️ Soni shubhali: ${html(item.resolved_name || item.name, 60)} ×${Math.max(1, Math.trunc(Number(item.quantity ?? 1)))}`
        : '⚠️ Mahsulot soni shubhali — tekshiring',
    );
  }
  if (has('duplicate_items')) {
    lines.push('⚠️ Bir xil mahsulot ikki marta yozilgan');
  }
  if (has('phone_is_market')) {
    lines.push('⚠️ Mijoz telefoni — marketning o‘z raqami');
  }
  const same = has('same_phone_multi');
  if (same) {
    const other = Number(same.other_index);
    lines.push(
      Number.isInteger(other) && other >= 0
        ? `⚠️ Shu telefon ${other + 1}-buyurtmada ham bor`
        : '⚠️ Shu telefon boshqa buyurtmada ham bor',
    );
  }
  return lines;
}

/** Yaratiladigan (🟢) buyurtmalardan birortasida bloklovchi tekshiruv bormi. */
export function needsAckConfirm(orders: AiPreviewOrder[]): boolean {
  return ackTargets(orders).length > 0;
}

/** «✅ Yaratish» → qayta so'rash oynasining sarlavhasi. */
export const AI_ACK_CONFIRM_TEXT =
  '⚠️ <b>Baribir yaratamanmi?</b> AI quyidagi buyurtmalarda tuman yoki summada ikkilandi:';
/** Ro'yxat sig'madi — «Ha» yo'q, kabinetga yo'naltiriladi. */
export const AI_ACK_TOO_MANY_TEXT =
  '⚠️ <b>AI {n} ta buyurtmada tuman yoki summada ikkilandi</b> — ularning hammasini bu yerda ko‘rsatib bo‘lmaydi. Iltimos, buyurtmalarni kabinetda tekshirib yarating.';
/** (S3) Server (409) qo'shimcha tasdiq so'radi — oyna ustidagi izoh. */
export const AI_ACK_SERVER_ASKED_TEXT =
  'ℹ️ Server bu buyurtmalar uchun AI ogohlantirishini tasdiqlashni so‘radi.';

/** «Baribir yaratamanmi?» oynasidagi bitta buyurtma va tasdiqlanadigan kodlar. */
export interface AiAckTarget {
  order: AiPreviewOrder;
  codes: string[];
}

/** «✅ Ha, yaratish» tugmasi payload'i: preview `index` → tasdiqlangan kodlar. */
export interface AiAckEntry {
  index: number;
  codes: string[];
}

/** Oynada ko'pi bilan shuncha buyurtma (undan ko'pi — kabinet). */
export const ACK_PROMPT_MAX_ORDERS = 10;
/** Telegram 4096 belgi chegarasidan zaxira bilan. */
const ACK_PROMPT_MAX_CHARS = 3900;

/**
 * (AI ack B3/S3) Tasdiq talab qiladigan YARATILADIGAN (🟢) buyurtmalar:
 * preview'dagi bloklovchi kodlar ∪ server (409 `orders[].missing`) so'ragan
 * kodlar (`extra`: preview `index` → kodlar). Tartib — preview tartibi.
 */
export function ackTargets(
  orders: AiPreviewOrder[],
  extra: ReadonlyMap<number, readonly string[]> = new Map(),
): AiAckTarget[] {
  const targets: AiAckTarget[] = [];
  for (const order of orders) {
    if (!isCreatable(order)) continue;
    const codes = new Set([
      ...blockingCheckCodes(order),
      ...(extra.get(order.index) ?? []).filter((c) => BLOCKING_CODES.has(c)),
    ]);
    if (codes.size === 0) continue;
    targets.push({
      order,
      codes: AI_BLOCKING_CHECK_CODES.filter((code) => codes.has(code)),
    });
  }
  return targets;
}

/** Faqat berilgan bloklovchi kodlar uchun «⚠️» qatorlari. */
function blockingLines(order: AiPreviewOrder, codes: string[]): string[] {
  const checks = Array.isArray(order.checks) ? order.checks : [];
  return checkLines(
    order,
    codes.map(
      (code) => checks.find((check) => check?.code === code) ?? { code },
    ),
  );
}

/**
 * (AI ack B3) «Baribir yaratamanmi?» oynasi — har tasdiqlanadigan buyurtma
 * ANIQ ro'yxatda («N) ⚠️ ism, telefon» + bloklovchi qatorlar). «Yuqorida ⚠️»
 * kabi havola YO'Q: operator tasdiqlagan hamma narsa shu xabarda ko'rinadi.
 * `fits=false` — ro'yxat (≤10 ta, ≤3900 belgi) sig'madi: «✅ Ha» berilmaydi,
 * kabinetga yo'naltiriladi.
 */
export function ackPromptText(
  targets: AiAckTarget[],
  intro?: string,
): { text: string; fits: boolean } {
  const head = intro ? [intro, ''] : [];
  const tooMany = () => ({
    text: [
      ...head,
      AI_ACK_TOO_MANY_TEXT.replace('{n}', String(targets.length)),
    ].join('\n'),
    fits: false,
  });
  if (targets.length > ACK_PROMPT_MAX_ORDERS) return tooMany();
  const lines = [...head, AI_ACK_CONFIRM_TEXT];
  for (const { order, codes } of targets) {
    lines.push(
      '',
      `<b>${order.index + 1})</b> ⚠️ 👤 ${html(order.customer_name) || '—'}, 📞 ${html(order.phone_number, 40) || '—'}`,
      ...blockingLines(order, codes),
    );
  }
  lines.push(
    '',
    'Tekshirdingizmi? «✅ Ha, yaratish» — faqat shu ro‘yxatdagi ogohlantirishlar tasdiqlanadi.',
  );
  const text = lines.join('\n');
  return text.length > ACK_PROMPT_MAX_CHARS ? tooMany() : { text, fits: true };
}

/** Telegram 4096 chegarasidan zaxira bilan (preview kartasi). */
const PREVIEW_MAX_CHARS = 3900;

/** Preview kartasi (shaxsiy chat — operatorning o'z buyurtmalari, PII bor). */
export function aiPreviewText(orders: AiPreviewOrder[]): string {
  return aiPreviewCard(orders).text;
}

/**
 * Preview kartasi va unda TO'LIQ ko'rsatilgan buyurtmalar soni (`shown`,
 * `orders` boshidan). Buyurtma bloki butunligicha sig'masa — kesiladi
 * (≤10 ta va ≤3900 belgi); pastki qator («✅ Yaratish — N ta…») doim
 * qoladi. Tugmalar faqat `shown` ichidagi buyurtmalarga.
 */
export function aiPreviewCard(orders: AiPreviewOrder[]): {
  text: string;
  shown: number;
} {
  const creatable = orders.filter(isCreatable).length;
  const head = `🤖 <b>AI ${orders.length} ta buyurtma topdi</b> — tekshiring:`;
  const footer = creatable
    ? `✅ «Yaratish» — ${creatable} ta tayyor buyurtma yaratiladi. 🟠 belgilisini kabinetda tuzating.`
    : '🟠 Tayyor buyurtma yo‘q — matnni tuzatib qayta yuboring yoki kabinetda yarating.';
  // «Yana N ta» — ko'rsatilmaganlarning tayyorlari ham «✅» bilan
  // yaratiladi (e7KhaeOO dan beri xatti-harakat) — matn shuni aytadi.
  const moreLine = (hidden: number) =>
    `… yana ${hidden} ta — tayyorlari ham «✅ Yaratish» bilan yaratiladi; ko‘rish va tuzatish — kabinetda.`;
  const blocks = orders
    .slice(0, PREVIEW_MAX_ORDERS)
    .map((order) => previewBlock(order).join('\n'));
  let shown = 0;
  let body = head;
  for (const block of blocks) {
    const next = `${body}\n\n${block}`;
    const hidden = orders.length - (shown + 1);
    const tail = hidden > 0 ? `\n\n${moreLine(hidden)}` : '';
    if (`${next}${tail}\n\n${footer}`.length > PREVIEW_MAX_CHARS) break;
    body = next;
    shown += 1;
  }
  const hidden = orders.length - shown;
  const text = [body, ...(hidden > 0 ? [moreLine(hidden)] : []), footer].join(
    '\n\n',
  );
  return { text, shown };
}

/** Bitta buyurtmaning kartadagi qatorlari. */
function previewBlock(order: AiPreviewOrder): string[] {
  const lines: string[] = [];
  {
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
      `<b>${order.index + 1})</b> ${isCreatable(order) ? '🟢' : '🟠'} 👤 ${html(order.customer_name) || '—'}, 📞 ${html(order.phone_number, 40) || '—'}`,
      `📍 ${escapeTelegramHtml(place || '—')}${clip(order.address, 120) ? ` — ${html(order.address)}` : ''}`,
      `📦 ${items || '—'}`,
      `💰 ${price} · ${order.where_deliver === 'center' ? '🏢 markazga' : '🏠 manzilga'}`,
      ...(replacement ? [replacement] : []),
      ...(issues ? [`⚠️ ${escapeTelegramHtml(issues)}`] : []),
      ...aiCheckLines(order),
      ...(order.confirm_order_id
        ? [
            `✅ Yaratilgan: ${escapeTelegramHtml(formatOrderNumber(order.confirm_order_id) ?? `#${clip(order.confirm_order_id, 20)}`)} — tuzatish faqat kabinetda`,
          ]
        : confirmAttempted(order)
          ? [AI_CONFIRM_UNKNOWN_LINE]
          : []),
    );
  }
  return lines;
}
