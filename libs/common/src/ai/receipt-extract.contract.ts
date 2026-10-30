import type { AiParseReason } from './claude.types';
import type { AiRequester } from './order-extract.contract';

/**
 * `ai.finance.receipt_extract` RMQ kontrakti (T3 QlLf33Ma) — api-gateway →
 * ai-service. Kassa cheki (to'lov kvitansiyasi / bank ilovasi skrinshoti)
 * dan summa, valyuta, sana, oluvchi, to'lovchi, bank va referens o'qiladi.
 *
 * ⚠️ PII: kartadan FAQAT oxirgi 4 raqam qaytadi (sanitize), rasm ham, model
 * matni ham logga yozilmaydi. Xarajat `AI_DAILY_USD_CAP` ga kiradi.
 */
export const AI_RECEIPT_EXTRACT_PATTERN = 'ai.finance.receipt_extract';

export type AiReceiptMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface AiReceiptExtractRequest {
  image_base64: string;
  media_type: AiReceiptMediaType;
  receipt_id: string;
  requester: AiRequester;
  /** Epoch ms — eskirgan xabar Anthropic'ga bormaydi. */
  deadline_at?: number;
}

export type AiReceiptExtractResponse =
  | {
      ok: true;
      /** Chekdagi summa (valyuta birligida) yoki o'qilmasa null. */
      amount: number | null;
      /** ISO 4217 (UZS, USD …) yoki null. */
      currency: string | null;
      /** Chekdagi sana/vaqt matni (≤ 40 belgi) yoki null. */
      date: string | null;
      recipient_name: string | null;
      /** FAQAT 4 raqam yoki null. */
      recipient_card_last4: string | null;
      payer_name: string | null;
      payer_card_last4: string | null;
      bank: string | null;
      /** Tranzaksiya / chek raqami (referens) yoki null. */
      reference: string | null;
      /** 0..1 */
      confidence: number | null;
      model: string;
    }
  | {
      ok: false;
      /**
       * `too_large` / `image_decode_failed` — gateway rasmni tayyorlay olmadi
       * (AI chaqirilmaydi; finance — `unreadable`).
       */
      reason: AiParseReason | 'too_large' | 'image_decode_failed';
    };
