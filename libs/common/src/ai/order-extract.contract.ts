import type { AiParseReason } from './claude.types';

/**
 * `ai.order.extract` RMQ kontrakti (api-gateway → ai-service) va
 * ekstraksiya chegaralari (C2).
 *
 * ⚠️ LLM faqat NOM va RAQAM chiqaradi — HECH QACHON ID emas. Bu tipda
 * district_id / product_id / region_id / market_id YO'Q: model "ishonarli"
 * soxta bigint ID qaytarsa u boshqa haqiqiy tumanga/mahsulotga tushib ketadi.
 */

/** Chaqiruvchi foydalanuvchi (JWT'dan) — rollar audit va meta uchun. */
export interface AiRequester {
  id: string;
  roles: string[];
}

/**
 * J3hEDtFN: noaniq maydon uchun ogohlantirish — model TAXMIN QILMAYDI, maydonni
 * null qoldirib shu yerga belgi qo'yadi. ⚠️ ATAYLAB erkin matn EMAS (faqat
 * enum): model matndagi ko'rsatmani (prompt-injection) yoki PII'ni bu kanal
 * orqali UI'ga ko'chira olmaydi; frontend matnni o'zi tuzadi.
 */
export const AI_EXTRACT_WARNING_FIELDS = [
  'customer_name',
  'phone_number',
  'extra_number',
  'region_name',
  'district_name',
  'address',
  'items',
  'total_price',
  'comment',
  'where_deliver',
  'is_replacement',
  'operator',
] as const;
export type AiExtractWarningField = (typeof AI_EXTRACT_WARNING_FIELDS)[number];

/**
 * `unclear` — o'qib/tushunib bo'lmadi (xira rasm, chala yozuv);
 * `ambiguous` — bir necha talqin (dona yoki jami narx? qaysi tuman?);
 * `conflict` — matnda bir-biriga zid qiymatlar (ikki xil narx/manzil).
 */
export const AI_EXTRACT_WARNING_REASONS = [
  'unclear',
  'ambiguous',
  'conflict',
] as const;
export type AiExtractWarningReason =
  (typeof AI_EXTRACT_WARNING_REASONS)[number];

export interface AiExtractWarning {
  field: AiExtractWarningField;
  reason: AiExtractWarningReason;
}

/** Bitta buyurtmadagi maksimal ogohlantirish (har maydonga bittadan). */
export const AI_MAX_WARNINGS_PER_ORDER = AI_EXTRACT_WARNING_FIELDS.length;

const WARNING_FIELD_SET = new Set<string>(AI_EXTRACT_WARNING_FIELDS);
const WARNING_REASON_SET = new Set<string>(AI_EXTRACT_WARNING_REASONS);

/**
 * Ogohlantirishlar oq ro'yxati (ai-service sanitize VA order-service preview
 * bir xil): faqat ma'lum maydon + ma'lum sabab, har maydonga BITTA
 * (birinchisi), `AI_EXTRACT_WARNING_FIELDS` tartibida. Massiv bo'lmasa — [].
 * Sof funksiya, hech qachon throw qilmaydi.
 */
export function sanitizeExtractWarnings(value: unknown): AiExtractWarning[] {
  if (!Array.isArray(value)) return [];
  const byField = new Map<string, AiExtractWarning>();
  for (const w of value as unknown[]) {
    if (w === null || typeof w !== 'object' || Array.isArray(w)) continue;
    const { field, reason } = w as { field?: unknown; reason?: unknown };
    if (typeof field !== 'string' || !WARNING_FIELD_SET.has(field)) continue;
    if (typeof reason !== 'string' || !WARNING_REASON_SET.has(reason)) continue;
    if (byField.has(field)) continue;
    byField.set(field, {
      field: field as AiExtractWarningField,
      reason: reason as AiExtractWarningReason,
    });
  }
  return AI_EXTRACT_WARNING_FIELDS.filter((f) => byField.has(f))
    .map((f) => byField.get(f) as AiExtractWarning)
    .slice(0, AI_MAX_WARNINGS_PER_ORDER);
}

/** Bitta buyurtma — ekstraksiya sxemasidagi 14 ta required maydon. */
export interface RawOrderExtraction {
  customer_name: string | null;
  phone_number: string | null;
  extra_number: string | null;
  region_name: string | null;
  district_name: string | null;
  address: string | null;
  full_address: string | null;
  items: { name: string; quantity: number }[];
  /** Narx aytilmasa null (0 EMAS). */
  total_price: number | null;
  comment: string | null;
  where_deliver: 'center' | 'address' | null;
  is_replacement: boolean;
  operator: string | null;
  /** J3hEDtFN: noaniq maydonlar (bo'sh massiv — ogohlantirish yo'q). */
  warnings: AiExtractWarning[];
}

/** WHMAIqyo: Anthropic qabul qiladigan va gateway ruxsat bergan rasm turlari. */
export type AiImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface AiOrderExtractRequest {
  text?: string;
  images?: {
    media_type: AiImageMediaType;
    data_base64: string;
  }[];
  /**
   * WHMAIqyo #3: rasmlar RMQ'da base64 EMAS — vaqtinchalik saqlovdagi KALITLAR
   * (`ai-tmp/<draft_id>/<n>.<ext>`, TTL 1 soat). Berilsa `images` bo'sh;
   * ai-service o'qiydi va darhol o'chiradi. Saqlov sozlanmagan bo'lsa gateway
   * eski `images` (base64) yo'lidan foydalanadi.
   */
  image_refs?: { key: string; media_type: AiImageMediaType }[];
  market_id: string;
  requester: AiRequester;
  trace_id: string | null;
  draft_id: string;
  /** Umumiy muddat (epoch ms) — eskirgan xabar Anthropic'ga yuborilmaydi. */
  deadline_at: number;
  request_id?: string;
}

export type AiOrderExtractResponse =
  | { ok: true; orders: RawOrderExtraction[] }
  | {
      ok: false;
      reason: AiParseReason;
      scope?: 'global';
      reset_at?: string;
    };

// ─── Chegaralar (gateway validatsiyasi, sanitize va DTO bir xil qiymatda) ───

/** ai-parse matnining maksimal uzunligi (belgi). */
export const AI_TEXT_MAX_CHARS = 4000;
/** Bitta parse'dagi maksimal rasm soni (WHMAIqyo: 3 → 20). */
export const AI_MAX_IMAGES = 20;
/** Bitta rasmning maksimal hajmi (bayt) — 1,5 MB (WHMAIqyo). */
export const AI_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/** Bitta parse'dagi barcha rasmlarning jami hajmi (bayt) — 20 MB (WHMAIqyo). */
export const AI_IMAGES_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/**
 * Serverda kichraytirish (WHMAIqyo #2): eng uzun tomon shu pikseldan oshmaydi,
 * qayta kodlash sifati ~80, EXIF olib tashlanadi.
 */
export const AI_IMAGE_MAX_EDGE_PX = 1568;
export const AI_IMAGE_REENCODE_QUALITY = 80;
/**
 * Ko'p rasm (WHMAIqyo #4): rasmlar shu o'lchamdagi bo'laklarga bo'linib
 * PARALLEL ekstraksiya qilinadi, natija birlashtiriladi (dublikat olinadi).
 */
export const AI_EXTRACT_IMAGES_PER_CHUNK = 5;
/** Bitta parse'dan qaytadigan maksimal buyurtma (ai-confirm DTO ham 30). */
export const AI_MAX_ORDERS_PER_PARSE = 30;
/** Bitta buyurtmadagi maksimal mahsulot qatori (ai-confirm DTO ham 50). */
export const AI_MAX_ITEMS_PER_ORDER = 50;
/** Bitta mahsulot qatorining maksimal soni. */
export const AI_MAX_QUANTITY = 1000;
/**
 * Bu summadan kichik narx shubhali ("250" = 250 ming?) — frontend
 * evalPreview'dagi PRICE_CONFIRM_THRESHOLD bilan bir xil.
 */
export const AI_PRICE_CONFIRM_THRESHOLD = 10_000;

/** Telefon deb hisoblanishi uchun minimal raqamlar soni. */
const JUNK_MIN_PHONE_DIGITS = 9;

function hasPhoneDigits(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.replace(/\D/g, '').length >= JUNK_MIN_PHONE_DIGITS
  );
}

/**
 * Axlat filtri (yxwpN5h5 #10): telefon HAM (phone_number yoki extra_number'da
 * kamida 9 raqam), mahsulot HAM (bo'sh bo'lmagan nomli item) yo'q element
 * buyurtma emas — natijadan tashlanadi. Sof funksiya, runtime'da null/xato
 * shakldagi maydonlarga chidamli (LLM chiqishi).
 */
export function isJunkRawOrder(
  o: Pick<RawOrderExtraction, 'phone_number' | 'extra_number' | 'items'>,
): boolean {
  if (hasPhoneDigits(o?.phone_number) || hasPhoneDigits(o?.extra_number)) {
    return false;
  }
  const items: unknown = o?.items;
  if (!Array.isArray(items)) return true;
  const hasNamedItem = items.some((it: unknown) => {
    const name: unknown = (it as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() !== '';
  });
  return !hasNamedItem;
}
