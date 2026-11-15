/**
 * AI buyurtma AUDIT IZI kontrakti (vncdmXOy): api-gateway ↔ ai-service
 * (`ai.draft.*` RPC'lari) va `ai_order_draft` snapshot shakli.
 *
 * ⚠️ MAXFIYLIK (HD5zOyBp): snapshot'da to'liq telefon YO'Q — faqat
 * maskalangan ko'rinish (`+99890*****67`) va normallashgan raqamning sha256'i
 * (operator raqamni o'zgartirganini aniqlash uchun). Snapshot'ni FAQAT
 * gateway quradi (`ai-order/ai-edited-fields.ts`) — ai-service uni o'zgartirmay
 * saqlaydi, shuning uchun solishtirish algoritmi bitta joyda.
 */

/** Operator o'zgartirishi mumkin bo'lgan va audit qilinadigan maydonlar (tartib qat'iy). */
export const AI_AUDITED_FIELDS = [
  'customer_name',
  'phone_number',
  'extra_number',
  'region_id',
  'district_id',
  'address',
  'total_price',
  'where_deliver',
  'comment',
  'operator',
  'items',
] as const;

export type AiAuditedField = (typeof AI_AUDITED_FIELDS)[number];

/** Bitta preview buyurtmaning kompakt nusxasi (AI TAKLIFI). */
export interface AiDraftPreviewSnapshot {
  /** Preview `index` i — ai-confirm `ai_item_index` shu qiymat. */
  index: number;
  customer_name: string | null;
  phone_masked: string | null;
  phone_sha256: string | null;
  extra_masked: string | null;
  extra_sha256: string | null;
  region_id: string | null;
  district_id: string | null;
  address: string | null;
  total_price: number | null;
  where_deliver: string | null;
  comment: string | null;
  operator: string | null;
  is_replacement: boolean;
  items: { name: string; product_id: string | null; quantity: number }[];
  /**
   * P1-7 (D6) — ixtiyoriy (eski snapshot'larda yo'q): tuman usuli, AI
   * o'qigan tuman matni va ball; viloyat AI taxminimi; yumshoq tekshiruv
   * kodlari. Eval va aniqlik tahlili uchun.
   */
  district_match?: {
    method: string;
    ai_text: string | null;
    score: number | null;
  } | null;
  region_inferred?: boolean;
  check_codes?: string[];
}

/**
 * WHMAIqyo #5: ai-parse bosqichlari davomiyligi (ms) — gateway o'lchaydi
 * (RPC kutish bilan birga): extract = `ai.order.extract`, preview =
 * `order.ai_resolve_preview`, total = butun ai-parse handler'i.
 */
export interface AiParseTimings {
  extract_ms: number;
  preview_ms: number | null;
  total_ms: number;
}

/** `ai.draft.attach_preview` (gateway → ai-service, fire-and-forget). */
export interface AiDraftAttachPreviewRequest {
  draft_id: string;
  market_id: string;
  previews: AiDraftPreviewSnapshot[];
  /** WHMAIqyo #5 — ixtiyoriy (eski gateway yubormaydi). */
  timings?: AiParseTimings;
}

/**
 * J3hEDtFN #4: operator tuzatishi — AI taklif qilgan qiymat va operator
 * TASDIQLAGAN qiymat (faqat o'zgargan maydonlar). Keyingi eval to'plami
 * uchun manba (`scripts/ai-eval-collect.ts`).
 * ⚠️ MAXFIYLIK: telefon HAR IKKALA tomonda faqat maskalangan
 * (`+99890*****67`); ism/manzil retention muddatida (30 kun) NULL bo'ladi.
 */
export type AiFieldCorrections = Partial<
  Record<AiAuditedField, { ai: unknown; final: unknown }>
>;

/** `ai.draft.confirm_context` so'rovi — faqat shu marketning draft'lari qaytadi. */
export interface AiDraftConfirmContextRequest {
  market_id: string;
  draft_ids: string[];
}

/** Bitta draft bo'yicha ai-confirm konteksti (audit metadata uchun). */
export interface AiDraftConfirmContext {
  draft_id: string;
  model: string;
  prompt_version: string;
  /** AI taklif qilgan buyurtmalar soni (xarajat ulushi uchun). */
  preview_count: number;
  /** `ai_usage_log` da shu draft_id bo'yicha jami (JOIN). */
  cost_usd: number;
  cost_uzs: number;
  /** Retention tugagan yoki preview yetib kelmagan bo'lsa null. */
  previews: AiDraftPreviewSnapshot[] | null;
}

export interface AiDraftConfirmContextResponse {
  drafts: AiDraftConfirmContext[];
}

/** `ai.usage.link_orders` ning ixtiyoriy `items` elementi (draft ↔ buyurtma). */
export interface AiDraftLinkItem {
  item_index: number | null;
  order_id: string;
  edited_fields: AiAuditedField[] | null;
  /** J3hEDtFN #4 — o'zgargan maydonlarning AI va yakuniy qiymati. */
  field_corrections?: AiFieldCorrections | null;
}

/** `ai.draft.trace_by_order` javobi — `GET /orders/:id/ai-trace` (SUPERADMIN/ADMIN). */
export interface AiDraftTrace {
  order_id: string;
  draft_id: string;
  item_index: number | null;
  market_id: string;
  user_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string;
  created_at: string;
  source_kind: string;
  /** Maskalangan matn (`[TEL_n]`); retention tugagach null. */
  source_text: string | null;
  source_hash: string;
  source_purged: boolean;
  image_count: number;
  model: string;
  prompt_version: string;
  outcome: string;
  /** AI taklifi — shu buyurtmaga mos snapshot (retention tugagach null). */
  ai_suggestion: AiDraftPreviewSnapshot | null;
  edited_fields: AiAuditedField[] | null;
  cost: {
    draft_cost_usd: number;
    draft_cost_uzs: number;
    calls: number;
    linked_orders: number;
    /** Buyurtma ulushi: draft xarajati / draft'dan yaratilgan buyurtmalar. */
    order_cost_uzs: number;
  };
}

/**
 * AI tekshiruvini TASDIQLASH (ack, ega qarori 2026-11-14): faqat shu
 * kodlar BLOKLAYDI — preview'da bo'lsa ai-confirm `orders[].ack_checks`
 * da ularni kutadi, aks holda 409 `CHECKS_NOT_ACKNOWLEDGED`. Qolgan
 * kodlar (qty_check, duplicate_items, phone_is_market, same_phone_multi)
 * — yumshoq ogohlantirish, ack so'ralmaydi.
 * ⚠️ Kodlar SERVERDA saqlangan snapshot'dan (`check_codes`) olinadi —
 * mijoz yuborgan `checks` ga ishonilmaydi.
 */
export const AI_BLOCKING_CHECK_CODES = [
  'district_low_confidence',
  'price_check',
] as const;

export type AiBlockingCheckCode = (typeof AI_BLOCKING_CHECK_CODES)[number];

/**
 * Operator tekshiruv tegishli maydonni O'ZI tuzatgan bo'lsa (server
 * hisoblagan `edited_fields` da bor), ack shart emas: tuman almashtirildi →
 * `district_low_confidence` endi taalluqli emas; summa o'zgartirildi →
 * `price_check` ham.
 */
export const AI_CHECK_EXEMPT_BY_EDIT: Readonly<
  Record<AiBlockingCheckCode, AiAuditedField>
> = {
  district_low_confidence: 'district_id',
  price_check: 'total_price',
};

/** ai-confirm 409 xato kodi (tanada `missing` va `orders`). */
export const AI_CHECKS_NOT_ACKNOWLEDGED = 'CHECKS_NOT_ACKNOWLEDGED';

/**
 * ai-confirm 503 (FE sessiya / ega, 2026-11-15): tekshiruvlarni ai-service'dan
 * o'qib bo'lmadi (timeout / xato) — FAIL-CLOSED, hech narsa yaratilmaydi;
 * `retryable: true`, `retry_after_seconds`.
 */
export const AI_CHECKS_UNAVAILABLE = 'AI_CHECKS_UNAVAILABLE';

/**
 * ai-confirm 400: buyurtmada `draft_id` yoki `ai_item_index` yo'q — ack
 * talabini chetlab o'tish yo'li bo'lmasin (`orders` — so'rovdagi o'rinlar).
 */
export const AI_DRAFT_REQUIRED = 'AI_DRAFT_REQUIRED';
