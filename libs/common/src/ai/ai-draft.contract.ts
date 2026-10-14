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
}

/** `ai.draft.attach_preview` (gateway → ai-service, fire-and-forget). */
export interface AiDraftAttachPreviewRequest {
  draft_id: string;
  market_id: string;
  previews: AiDraftPreviewSnapshot[];
}

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
