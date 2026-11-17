import {
  AI_BLOCKING_CHECK_CODES,
  AI_CHECK_EXEMPT_BY_EDIT,
  type AiAuditedField,
  type AiBlockingCheckCode,
  type AiDraftPreviewSnapshot,
} from '@app/common';

/**
 * AI tekshiruvini TASDIQLASH (ack, ega qarori 2026-11-14) — ai-confirm.
 *
 * Qaysi kodlar tasdiq talab qiladi — FAQAT serverda saqlangan AI taklifi
 * snapshot'idan (`check_codes`, ai-parse oxirida gateway o'zi quradi va
 * ai-service saqlaydi). Mijoz yuborgan preview / `checks` ga ishonilmaydi;
 * mijozdan faqat `ack_checks` (operator «baribir yaratish»ni bosgani) olinadi.
 *
 * Qoida:
 *  - snapshot topilmadi (draft_id / ai_item_index yo'q, draft retention'dan
 *    o'tgan, ai-service javob bermadi) yoki unda `check_codes` yo'q (eski
 *    draft) → ack SHART EMAS (orqaga moslik);
 *  - `check_codes` ∩ `AI_BLOCKING_CHECK_CODES` — talab qilinadigan kodlar;
 *  - operator tekshiruv tegishli maydonni O'ZI o'zgartirgan bo'lsa (server
 *    hisoblagan `edited_fields`): `district_id` → `district_low_confidence`,
 *    `total_price` → `price_check` talab qilinmaydi (`AI_CHECK_EXEMPT_BY_EDIT`).
 */
export function requiredAckChecks(
  preview: AiDraftPreviewSnapshot | null,
  editedFields: readonly AiAuditedField[] | null,
): AiBlockingCheckCode[] {
  const codes = preview?.check_codes;
  if (!Array.isArray(codes) || codes.length === 0) return [];
  const edited = new Set(editedFields ?? []);
  return AI_BLOCKING_CHECK_CODES.filter(
    (code) =>
      codes.includes(code) && !edited.has(AI_CHECK_EXEMPT_BY_EDIT[code]),
  );
}

/** Talab qilingan, lekin `ack_checks` da yo'q kodlar (talab tartibida). */
export function missingAckChecks(
  required: readonly string[],
  ackChecks: readonly unknown[] | null | undefined,
): string[] {
  if (required.length === 0) return [];
  const acked = new Set(
    (Array.isArray(ackChecks) ? ackChecks : []).filter(
      (c): c is string => typeof c === 'string',
    ),
  );
  return required.filter((code) => !acked.has(code));
}
