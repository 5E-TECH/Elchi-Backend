import type { AiRequester, RawOrderExtraction } from '@app/common';

/**
 * `order.ai_resolve_preview` shartnomasi (C7/C9): ai-service chiqargan XOM
 * buyurtmalar (nomlar, raqamlar) → operator tasdiqlaydigan YASSI preview.
 *
 * ⚠️ SHARTNOMA: `AiOrderPreview` Elchi-Frontend
 * `src/entities/ai-order/types.ts` dagi `AiPreviewOrder` bilan AYNAN bir xil
 * (yassi: customer_name, region_id, district_id, items[].name ...). Bir tomonda
 * o'zgarsa ikkinchisi ham o'zgarishi SHART, aks holda frontend javobni o'qiy
 * olmaydi. Frontend e'tiborsiz qoldiradigan qo'shimcha kalitlar: index, ready,
 * issues, price_confirmed, is_replacement, items[].unresolved.
 */

/**
 * RMQ orqali kelgan bitta xom buyurtma. ai-service `sanitize` dan o'tgan
 * bo'lsa ham RMQ chegarasi — har maydon runtime'da qayta tekshiriladi
 * (yo'q / null / noto'g'ri tip bo'lishi mumkin), shu sabab hammasi ixtiyoriy.
 */
export type RawExtraction = Partial<RawOrderExtraction>;

/**
 * Kamchilik KALITLARI — Elchi-Frontend
 * `pages/orders/create/ui/ai/evalPreview.ts` dagi `AI_ISSUES` bilan bir xil
 * tartibda. MATN emas: tarjima frontend qatlamida (i18n).
 */
export const AI_ISSUES = [
  'name_missing',
  'phone_invalid',
  'region_missing',
  'district_missing',
  'price_missing',
  'price_confirm',
  'items_missing',
  'item_unresolved',
] as const;

export type AiIssue = (typeof AI_ISSUES)[number];

/** Katalogdan mos kelishi mumkin bo'lgan mahsulot (operator tanlaydi). */
export interface AiProductCandidate {
  id: string;
  name: string;
}

/** Tuman nomzodi: `label` = "<kanonik viloyat>, <tuman>"; `region_name` = DB'dagi aynan nom. */
export interface AiDistrictCandidate {
  id: string;
  label: string;
  region_name: string;
}

export interface AiPreviewItem {
  /** AI matndan o'qigan nom — hech qachon null emas. */
  name: string;
  quantity: number;
  product_id: string | null;
  /** Katalogdagi mos mahsulot nomi (faqat ko'rsatish uchun). */
  resolved_name: string | null;
  candidates: AiProductCandidate[];
  /** Katalogdan avtomatik tanlanmadi — operator hal qilishi kerak. */
  unresolved: boolean;
}

/**
 * Operatorga ko'rsatiladigan bitta buyurtma (C9).
 *
 * ⚠️ Bu obyektda HECH QACHON `product_name`, `allow_free_text`,
 * `operator_id`, `parent_order_id`, ball (score) yoki `[TEL_n]` tokeni
 * bo'lmaydi — preview kalitlar ro'yxati (whitelist) bo'yicha yig'iladi.
 */
export interface AiOrderPreview {
  index: number;
  ready: boolean;
  issues: AiIssue[];
  /** Matnda bo'lmasa '' — frontend `name_missing` ko'rsatadi ("Mijoz" default YO'Q). */
  customer_name: string;
  /** '+998XXXXXXXXX' | normallashmagan xom matn (trim) | ''. */
  phone_number: string;
  extra_number: string | null;
  /** Aniqlangan tumanning `region_id` si (yoki qulflangan viloyat). */
  region_id: string | null;
  /** DB'dagi aynan `region.name`. */
  region_name: string | null;
  /** Viloyat matnda aniq aytilganmi (`regionAlias` topdi). */
  region_given: boolean;
  /** `district_candidates` bo'sh bo'lmasa HAR DOIM null. */
  district_id: string | null;
  district_name: string | null;
  district_candidates: AiDistrictCandidate[];
  address: string | null;
  items: AiPreviewItem[];
  total_price: number | null;
  /** Backend hech qachon tasdiqlamaydi — tasdiq faqat operator UI'sida. */
  price_confirmed: false;
  where_deliver: 'center' | 'address';
  comment: string | null;
  is_replacement: boolean;
  /** Faqat matn ("#sevinch" → "sevinch"); `operator_id` ga HECH QACHON bog'lanmaydi. */
  operator: string | null;
}

/** `logistics.district.resolve_by_text` so'rovining bitta elementi (C7). */
export interface DistrictTextQuery {
  region_name?: string;
  district_name?: string;
  address?: string;
  full_address?: string;
}

/**
 * `logistics.district.resolve_by_text` javobining bitta elementi (C7) —
 * so'rov tartibida. Egasi logistics-service (B2-T1); bu yerda faqat
 * order-service o'qiydigan maydonlar nusxasi.
 */
export interface DistrictTextResolution {
  region_id: string | null;
  district_id: string | null;
  region_label?: string | null;
  district_label?: string | null;
  region_name: string | null;
  district_name: string | null;
  region_given: boolean;
  candidates: {
    id: string;
    label: string;
    region_name: string;
    district_name?: string | null;
  }[];
  reason?:
    | 'region_ambiguous'
    | 'district_not_found'
    | 'district_ambiguous'
    | 'no_place_signal'
    | 'cross_region_confusable'
    | 'sato_mismatch';
}

/** `order.ai_resolve_preview` so'rovi (gateway → order-service). */
export interface AiResolvePreviewRequest {
  raw_orders?: RawExtraction[] | null;
  market_id: string;
  requester: AiRequester;
  /** Gateway har chaqiruvda `randomUUID()` beradi (runIdempotent kaliti). */
  request_id?: string;
  trace_id: string | null;
  draft_id: string | null;
  /** Umumiy muddat (epoch ms) — LLM fallback shundan oshmaydi. */
  deadline_at: number;
}

export interface AiResolvePreviewResponse {
  previews: AiOrderPreview[];
}
