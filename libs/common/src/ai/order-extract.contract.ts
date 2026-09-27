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

/** Bitta buyurtma — ekstraksiya sxemasidagi 13 ta required maydon. */
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
}

export interface AiOrderExtractRequest {
  text?: string;
  images?: {
    media_type: 'image/jpeg' | 'image/png';
    data_base64: string;
  }[];
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
/** Bitta parse'dagi maksimal rasm soni. */
export const AI_MAX_IMAGES = 3;
/** Bitta rasmning maksimal hajmi (bayt) — 2 MB. */
export const AI_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
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
