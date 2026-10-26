import { ShiftAccountAiStatus } from '../entities/shift-account-check.types';

/**
 * kiZgTybn — smena yopishda karta qoldig'ini tasdiqlash QOIDALARI (sof
 * funksiyalar: DB'siz test qilinadi).
 */

/** Global sozlama kalitlari (`finance_settings.key`). */
export const SHIFT_SETTING_KEYS = {
  accountCheckEnabled: 'shift.account_check.enabled',
  photoRequired: 'shift.photo.required',
  aiCheckEnabled: 'shift.ai_check.enabled',
} as const;

export interface ShiftCheckSettings {
  /** Yoqilgan — yopishda kassaning HAR faol kartasi uchun `accounts[]` majburiy. */
  account_check_enabled: boolean;
  /** Master kalit: o'chiq — hech bir kartada rasm majburiy emas. */
  photo_required: boolean;
  /** Master kalit: o'chiq — AI umuman chaqirilmaydi (pul sarflanmaydi). */
  ai_check_enabled: boolean;
}

/**
 * Sukut (qator yo'q): tasdiqlash O'CHIQ (mavjud yopish oqimi o'zgarmaydi,
 * superadmin yoqadi), rasm master kaliti YOQIQ (karta bo'yicha
 * `require_photo_on_shift_close` hal qiladi), AI O'CHIQ (pulli — superadmin
 * ataylab yoqadi).
 */
export const SHIFT_CHECK_DEFAULTS: ShiftCheckSettings = {
  account_check_enabled: false,
  photo_required: true,
  ai_check_enabled: false,
};

/** AI qoldiq mosligi chegarasi: |farq| ≤ 1 so'm. */
export const AI_MATCH_TOLERANCE = 1;
/** Shundan past ishonch — `unreadable`. */
export const AI_MIN_CONFIDENCE = 0.5;

export const ACCOUNT_COMMENT_REQUIRED_MESSAGE =
  'farq bor yoki AI natijasi mos emas — izoh majburiy';
export const ACCOUNT_PHOTO_REQUIRED_MESSAGE =
  'qoldiq rasmi (skrinshot) majburiy — avval rasm yuklang';

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface CardRuleSource {
  require_photo_on_shift_close?: boolean | null;
  ai_check_enabled?: boolean | null;
}

export function isPhotoRequired(
  settings: ShiftCheckSettings,
  card: CardRuleSource,
): boolean {
  return Boolean(settings.photo_required && card.require_photo_on_shift_close);
}

export function isAiEnabled(
  settings: ShiftCheckSettings,
  card: CardRuleSource,
): boolean {
  return Boolean(settings.ai_check_enabled && card.ai_check_enabled);
}

/** AI javobi (ai-service `AiBalanceScreenshotResponse` shakli). */
export type AiCheckResult =
  | {
      ok: true;
      balance: number | null;
      last4: string | null;
      date?: string | null;
      confidence: number | null;
      model?: string | null;
    }
  | { ok: false; reason?: string | null };

/** Model javob berdi, lekin rasm o'qib bo'lmadi — `unreadable`; qolgani `error`. */
const UNREADABLE_REASONS = new Set(['refused', 'invalid_json', 'truncated']);

/**
 * (a) `ai_status` — rasmdagi qoldiq TIZIMDAGI qoldiq bilan:
 *   match    — |o'qilgan − kutilgan| ≤ 1 so'm VA last4 mos (kartada last4
 *              bo'lsa rasmda ham aynan shu 4 raqam o'qilishi shart);
 *   mismatch — aks holda;
 *   unreadable — qoldiq o'qilmadi / ishonch < 0.5 / model rad etdi;
 *   error    — tarmoq, cap, AI o'chiq va h.k.
 */
export function deriveAiStatus(input: {
  ok: boolean;
  reason?: string | null;
  read_balance: number | null;
  last4_detected: string | null;
  confidence: number | null;
  expected_balance: number | null;
  card_last4: string | null;
}): ShiftAccountAiStatus {
  if (!input.ok) {
    return UNREADABLE_REASONS.has(String(input.reason ?? ''))
      ? ShiftAccountAiStatus.UNREADABLE
      : ShiftAccountAiStatus.ERROR;
  }
  if (
    input.read_balance == null ||
    !Number.isFinite(Number(input.read_balance)) ||
    (input.confidence != null && input.confidence < AI_MIN_CONFIDENCE)
  ) {
    return ShiftAccountAiStatus.UNREADABLE;
  }
  if (input.expected_balance == null) {
    return ShiftAccountAiStatus.UNREADABLE;
  }
  const balanceOk =
    Math.abs(Number(input.read_balance) - Number(input.expected_balance)) <=
    AI_MATCH_TOLERANCE;
  const cardLast4 = (input.card_last4 ?? '').trim();
  const last4Ok = !cardLast4 || input.last4_detected === cardLast4;
  return balanceOk && last4Ok
    ? ShiftAccountAiStatus.MATCH
    : ShiftAccountAiStatus.MISMATCH;
}

/** (b) `ai_entered_ok` — kassir kiritgan qiymat rasmdagisi bilan bir xilmi. */
export function deriveEnteredOk(
  entered: number | null | undefined,
  read: number | null | undefined,
): boolean | null {
  if (entered == null || read == null) return null;
  if (!Number.isFinite(Number(entered)) || !Number.isFinite(Number(read))) {
    return null;
  }
  return Math.abs(Number(entered) - Number(read)) <= AI_MATCH_TOLERANCE;
}

/** Izoh majburiymi: farq ≠ 0, AI `mismatch` yoki kiritilgan ≠ rasmdagi. */
export function isCommentRequired(input: {
  difference: number | null;
  ai_status: string | null;
  ai_entered_ok: boolean | null;
}): boolean {
  return (
    (input.difference != null && round2(input.difference) !== 0) ||
    input.ai_status === ShiftAccountAiStatus.MISMATCH ||
    input.ai_entered_ok === false
  );
}

/** Natijalar sarhisobi (hisobot / activity-log uchun). */
export function summarizeStatuses(
  rows: Array<{ ai_status: string; ai_entered_ok: boolean | null }>,
): Record<string, number> {
  const summary: Record<string, number> = {
    total: rows.length,
    entered_mismatch: 0,
  };
  for (const status of Object.values(ShiftAccountAiStatus)) {
    summary[status] = 0;
  }
  for (const row of rows) {
    summary[row.ai_status] = (summary[row.ai_status] ?? 0) + 1;
    if (row.ai_entered_ok === false) summary.entered_mismatch += 1;
  }
  return summary;
}
