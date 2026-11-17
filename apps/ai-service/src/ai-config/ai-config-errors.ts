import {
  AI_CONFIG_ERROR_STATUS,
  type AiConfigErrorCode,
  type AiConfigRpcError,
} from '@app/common';

/**
 * Xato natijasi (throw EMAS). `message` — ichki (FE ko'rsatmaydi, faqat
 * `code`); kalit qiymati HECH QACHON yo'q.
 */
const MESSAGES: Partial<Record<AiConfigErrorCode, string>> = {
  AI_CONFIG_UNSIGNED: "AI sozlamasini o'zgartirish o'chiq (imzo)",
  AI_CONFIG_NOT_ALLOWED: 'Ruxsat etilmagan',
  AI_CONFIG_UI_DISABLED: "UI'dan o'zgartirish o'chiq",
  AI_CONFIG_EXPIRED: "So'rov kechikdi — hech narsa o'zgarmadi",
};

export function aiConfigError(
  code: AiConfigErrorCode,
  extra: Partial<
    Omit<AiConfigRpcError, 'statusCode' | 'message' | 'code'>
  > = {},
): { ok: false; error: AiConfigRpcError } {
  return {
    ok: false,
    error: {
      statusCode: AI_CONFIG_ERROR_STATUS[code],
      message: MESSAGES[code] ?? code,
      code,
      ...extra,
    },
  };
}

/** Tranzaksiyani orqaga qaytarish uchun ichki throw (handler'dan chiqmaydi). */
export class AiConfigAbort extends Error {
  constructor(
    readonly code: AiConfigErrorCode,
    readonly extra: Partial<AiConfigRpcError> = {},
  ) {
    super(code);
    this.name = 'AiConfigAbort';
  }
}
