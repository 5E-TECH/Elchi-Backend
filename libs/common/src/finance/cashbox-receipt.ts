/**
 * T3 (QlLf33Ma) — kassa CHEKI: qo'lda chiqim va HQ'ga o'tkazmalarda chek
 * rasmi + AI tahlili. Gateway ↔ finance-service kontrakti: turlar, holatlar,
 * sozlama kalitlari, xato kodlari (`PUBLIC_ERROR_CODES` ga ham) va sozlama
 * qoidasi.
 *
 * SAQLASH: operatsiyaga bog'langan (`linked`) chek va uning fayli HECH QACHON
 * avtomatik o'chirilmaydi — tarixdan keyin ham ko'riladi. Faqat bog'lanmagan
 * qoralama (`draft`) 24 soatdan keyin tozalanadi.
 */

/** Chek turi: qaysi operatsiyaga biriktiriladi. */
export const CASHBOX_RECEIPT_KINDS = [
  'manual_expense',
  'courier_to_hq',
  'branch_to_hq',
] as const;
export type CashboxReceiptKind = (typeof CASHBOX_RECEIPT_KINDS)[number];

export const isCashboxReceiptKind = (
  value: unknown,
): value is CashboxReceiptKind =>
  typeof value === 'string' &&
  (CASHBOX_RECEIPT_KINDS as readonly string[]).includes(value);

/** Sozlama guruhi: qo'lda chiqim yoki HQ'ga o'tkazma (kuryer va filial). */
export const CASHBOX_RECEIPT_SETTING_GROUPS = [
  'manual_expense',
  'hq_transfer',
] as const;
export type CashboxReceiptSettingGroup =
  (typeof CASHBOX_RECEIPT_SETTING_GROUPS)[number];

export const receiptSettingGroupOf = (
  kind: CashboxReceiptKind,
): CashboxReceiptSettingGroup =>
  kind === 'manual_expense' ? 'manual_expense' : 'hq_transfer';

/** `finance_settings` kalitlari (qiymat — boolean; qator yo'q — `true`). */
export const CASHBOX_RECEIPT_SETTING_KEYS: Readonly<
  Record<
    CashboxReceiptSettingGroup,
    { photo_required: string; ai_enabled: string }
  >
> = Object.freeze({
  manual_expense: {
    photo_required: 'receipt.manual_expense.photo_required',
    ai_enabled: 'receipt.manual_expense.ai_enabled',
  },
  hq_transfer: {
    photo_required: 'receipt.hq_transfer.photo_required',
    ai_enabled: 'receipt.hq_transfer.ai_enabled',
  },
});

export interface CashboxReceiptGroupSettings {
  photo_required: boolean;
  ai_enabled: boolean;
}

export type CashboxReceiptSettings = Record<
  CashboxReceiptSettingGroup,
  CashboxReceiptGroupSettings
>;

/** Sukut — ikkalasi ham YOQIQ (ega qarori 1). */
export const CASHBOX_RECEIPT_DEFAULTS: CashboxReceiptGroupSettings =
  Object.freeze({ photo_required: true, ai_enabled: true });

/** Chek holati: yuklangan, lekin operatsiyaga hali bog'lanmagan / bog'langan. */
export const CASHBOX_RECEIPT_STATES = ['draft', 'linked'] as const;
export type CashboxReceiptState = (typeof CASHBOX_RECEIPT_STATES)[number];

/** AI tahlili holati (`cashbox_receipts.ai_status`). */
export const CASHBOX_RECEIPT_AI_STATUSES = [
  'disabled',
  'pending',
  'match',
  'mismatch',
  'unreadable',
  'error',
] as const;
export type CashboxReceiptAiStatus =
  (typeof CASHBOX_RECEIPT_AI_STATUSES)[number];

/**
 * Tarix filtri `receipt_status`: AI holatlari + `none` («Chek yo'q» — chek
 * so'raladigan, lekin cheksiz qator).
 */
export const CASHBOX_RECEIPT_FILTER_STATUSES = [
  'match',
  'mismatch',
  'unreadable',
  'pending',
  'error',
  'disabled',
  'none',
] as const;
export type CashboxReceiptFilterStatus =
  (typeof CASHBOX_RECEIPT_FILTER_STATUSES)[number];

/** Qoralama shuncha soatdan keyin (bog'lanmagan bo'lsa) tozalanadi. */
export const CASHBOX_RECEIPT_DRAFT_TTL_HOURS = 24;
/** AI natijasi shundan ko'p kechiksa `ai_stale` (qayta tahlil ruxsat). */
export const CASHBOX_RECEIPT_AI_STALE_MS = 3 * 60_000;
/** Bitta chekka AI urinishlari chegarasi. */
export const CASHBOX_RECEIPT_AI_MAX_ATTEMPTS = 5;
/** Rasm: jpeg / png / webp, ≤ 5 MB (smena rasmi bilan bir xil). */
export const CASHBOX_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
/** file-service papkasi → kalit prefiksi `cashbox-receipt-`. */
export const CASHBOX_RECEIPT_FILE_FOLDER = 'cashbox-receipt';

/** Javobdagi `code` (FE matnni emas, kodni tekshiradi). */
export const CASHBOX_RECEIPT_ERROR_CODES = {
  /** 400 — natijada AI yoqiq, rasm o'chiq. */
  AI_REQUIRES_PHOTO: 'RECEIPT_AI_REQUIRES_PHOTO',
  /** 400 — bu tur uchun chek rasmi o'chirilgan (yuklash shart emas). */
  DISABLED: 'RECEIPT_DISABLED',
  /** 400 — chek majburiy, `receipt_id` yo'q. */
  REQUIRED: 'RECEIPT_REQUIRED',
  /** 400 — chek topilmadi (yoki qoralama tozalangan). */
  NOT_FOUND: 'RECEIPT_NOT_FOUND',
  /** 403 — chekni boshqa xodim yuklagan. */
  NOT_OWNER: 'RECEIPT_NOT_OWNER',
  /** 400 — chek turi operatsiyaga mos emas. */
  KIND_MISMATCH: 'RECEIPT_KIND_MISMATCH',
  /** 409 — chek boshqa operatsiyaga allaqachon bog'langan. */
  ALREADY_USED: 'RECEIPT_ALREADY_USED',
  /** 400 — bu operatsiyada chek qo'llanmaydi (naqd, click_to_market …). */
  NOT_APPLICABLE: 'RECEIPT_NOT_APPLICABLE',
  /** 409 — chek «Mos keldi» — qayta tahlil kerak emas. */
  ALREADY_MATCHED: 'RECEIPT_ALREADY_MATCHED',
  /** 400 — AI tahlili o'chiq (chekda yoki joriy sozlamada). */
  AI_DISABLED: 'RECEIPT_AI_DISABLED',
  /** 409 — AI tahlili hali davom etmoqda. */
  AI_PENDING: 'RECEIPT_AI_PENDING',
  /** 429 — AI urinishlari tugadi. */
  AI_ATTEMPTS_EXHAUSTED: 'RECEIPT_AI_ATTEMPTS_EXHAUSTED',
} as const;
export type CashboxReceiptErrorCode =
  (typeof CASHBOX_RECEIPT_ERROR_CODES)[keyof typeof CASHBOX_RECEIPT_ERROR_CODES];

export const CASHBOX_RECEIPT_MESSAGES: Readonly<
  Record<CashboxReceiptErrorCode, string>
> = Object.freeze({
  RECEIPT_AI_REQUIRES_PHOTO: 'AI tahlili faqat chek rasmi yoqilganda ishlaydi',
  RECEIPT_DISABLED: "Bu operatsiya uchun chek rasmi o'chirilgan",
  RECEIPT_REQUIRED: 'Chek rasmini yuklang',
  RECEIPT_NOT_FOUND: 'Chek topilmadi — rasmni qayta yuklang',
  RECEIPT_NOT_OWNER: 'Bu chekni boshqa xodim yuklagan',
  RECEIPT_KIND_MISMATCH: 'Chek turi bu operatsiyaga mos emas',
  RECEIPT_ALREADY_USED: 'Bu chek boshqa operatsiyaga biriktirilgan',
  RECEIPT_NOT_APPLICABLE: "Bu operatsiyada chek qo'llanmaydi",
  RECEIPT_ALREADY_MATCHED: 'Chek mos keldi — qayta tahlil kerak emas',
  RECEIPT_AI_DISABLED: "Bu chek uchun AI tahlili o'chiq",
  RECEIPT_AI_PENDING: 'AI tahlili davom etmoqda',
  RECEIPT_AI_ATTEMPTS_EXHAUSTED: 'AI tahlili urinishlari tugadi',
});

export type CashboxReceiptSettingsPatch = Partial<
  Record<CashboxReceiptSettingGroup, Partial<CashboxReceiptGroupSettings>>
>;

export type ApplyReceiptSettingsResult =
  | { ok: true; value: CashboxReceiptSettings }
  | { ok: false; code: CashboxReceiptErrorCode; group: string };

/**
 * Sozlama o'zgarishi (smena rasmi qoidasi bilan bir xil):
 *  - faqat `photo_required:false` kelsa — AI ham o'chadi;
 *  - rasm qayta yoqilsa — AI avvalgi (o'chiq) holatida qoladi;
 *  - natijada `ai_enabled && !photo_required` → `RECEIPT_AI_REQUIRES_PHOTO`.
 */
export function applyReceiptSettingsPatch(
  current: CashboxReceiptSettings,
  patch: CashboxReceiptSettingsPatch,
): ApplyReceiptSettingsResult {
  const next = {
    manual_expense: { ...current.manual_expense },
    hq_transfer: { ...current.hq_transfer },
  };
  for (const group of CASHBOX_RECEIPT_SETTING_GROUPS) {
    const item = patch[group];
    if (!item) continue;
    const photo = item.photo_required ?? current[group].photo_required;
    const ai =
      item.ai_enabled !== undefined
        ? item.ai_enabled
        : item.photo_required === false
          ? false
          : current[group].ai_enabled;
    if (ai && !photo) {
      return {
        ok: false,
        code: CASHBOX_RECEIPT_ERROR_CODES.AI_REQUIRES_PHOTO,
        group,
      };
    }
    next[group] = { photo_required: photo, ai_enabled: ai };
  }
  return { ok: true, value: next };
}
