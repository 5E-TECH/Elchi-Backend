import type { AiParseReason } from './claude.types';
import type { AiRequester } from './order-extract.contract';

/**
 * `ai.finance.balance_screenshot` RMQ kontrakti (kiZgTybn) — api-gateway →
 * ai-service. Smena yopishda karta / hisob qoldig'i skrinshotidan QOLDIQ,
 * karta oxirgi 4 raqami va sana o'qiladi.
 *
 * ⚠️ PII: rasmda to'liq karta raqami bo'lishi mumkin — javobda FAQAT oxirgi
 * 4 raqam qaytadi (sanitize), rasm ham, model matni ham logga yozilmaydi.
 * Xarajat `AI_DAILY_USD_CAP` ga kiradi (ClaudeService global shifti).
 */
export const AI_BALANCE_SCREENSHOT_PATTERN = 'ai.finance.balance_screenshot';

export type AiBalanceScreenshotMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export interface AiBalanceScreenshotRequest {
  image_base64: string;
  media_type: AiBalanceScreenshotMediaType;
  shift_id: string;
  card_id: string;
  requester: AiRequester;
  /** Epoch ms — eskirgan xabar Anthropic'ga bormaydi. */
  deadline_at?: number;
}

export type AiBalanceScreenshotResponse =
  | {
      ok: true;
      /** Rasmdagi qoldiq (so'm) yoki o'qilmasa null. */
      balance: number | null;
      /** FAQAT 4 raqam yoki null. */
      last4: string | null;
      /** Rasmdagi sana (matn, ≤ 40 belgi) yoki null. */
      date: string | null;
      /** 0..1 */
      confidence: number | null;
      model: string;
    }
  | { ok: false; reason: AiParseReason };
