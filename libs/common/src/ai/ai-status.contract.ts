import type { AnthropicKeyState } from './claude.types';

/**
 * `ai.status` RMQ javobi va gateway `/health` dagi `ai` maydoni (C2).
 */

/**
 * AI holati: `cap_exceeded` — global kunlik shift urilgan ('disabled' EMAS —
 * UI "AI limiti" deb alohida ko'rsatadi); `unknown` — ai-service javob bermadi.
 */
export type AiHealthState = 'enabled' | 'disabled' | 'cap_exceeded' | 'unknown';

/** Kunlik shift holati: ok / 80% ogohlantirish / oshgan / o'qib bo'lmadi. */
export type AiCapState = 'ok' | 'warn' | 'exceeded' | 'unknown';

/**
 * Model siyosati natijasi (LP3RKvXY #2): `ok` — ruxsat etilgan kuchli
 * ekstraksiya modeli; `weak` — narx jadvalida bor, lekin ekstraksiya uchun
 * kuchsiz (masalan Haiku); `unknown` — narx jadvali bilmaydi (xato nom?).
 */
export type AiModelVerdict = 'ok' | 'weak' | 'unknown';

export interface AiModelPolicy {
  /** Hammasi `ok` bo'lsa true — dashboard `false` da QIZIL belgi ko'rsatadi. */
  ok: boolean;
  order: AiModelVerdict;
  vision: AiModelVerdict;
  /** Klassifikatsiya modelida faqat `ok | unknown` (arzon model qonuniy). */
  classify: AiModelVerdict;
}

export interface AiStatusResponse {
  enabled: boolean;
  /** Faqat holat — kalit qiymati HECH QACHON qaytmaydi. */
  key_state: AnthropicKeyState;
  models: { order: string; vision: string; classify: string };
  /** LP3RKvXY: ekstraksiya modeli pasaytirilganmi (boot'ni yiqitmaydi). */
  model_policy: AiModelPolicy;
  cap: {
    /** Toshkent sanasi (YYYY-MM-DD). */
    period_key: string;
    spent_usd: number;
    cap_usd: number;
    override_usd: number;
    effective_cap_usd: number;
    ratio: number;
    state: AiCapState;
    reset_at: string;
  };
  /** Fire-and-forget jurnal yozuvi yiqilgan chaqiruvlar soni. */
  usage_persist_failures: number;
}
