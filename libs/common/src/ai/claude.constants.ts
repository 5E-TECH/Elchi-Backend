/**
 * ClaudeService DI tokenlari va vaqt/token konstantalari (C2 kontrakti).
 */

/** Xarajat jurnali porti (`ClaudeUsageSink`) uchun ixtiyoriy DI token. */
export const CLAUDE_USAGE_SINK = Symbol('CLAUDE_USAGE_SINK');

/** Global kunlik shift porti (`ClaudeBudgetGuard`) uchun ixtiyoriy DI token. */
export const CLAUDE_BUDGET_GUARD = Symbol('CLAUDE_BUDGET_GUARD');

/** Anthropic mijoz fabrikasi (`AnthropicClientFactory`) uchun DI token. */
export const ANTHROPIC_CLIENT_FACTORY = Symbol('ANTHROPIC_CLIENT_FACTORY');

/** To'g'ri env kalit nomi — xato nomlarni (ANTROPIC_API_KEY) ajratish uchun. */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * ⚠️ SDK timeout — 55 s. Zanjir: SDK 55s < RPC 60s (AI_RPC_TIMEOUT_MS) <
 * frontend 90s < Cloudflare ~100s. SDK sukuti 10 DAQIQA — u RPC timeout'idan
 * keyin ham Anthropic'ni kutib, bekorga pul yoqib turardi.
 */
export const ANTHROPIC_TIMEOUT_MS = 55_000;

/**
 * ⚠️ SDK o'z retry'sini QILMAYDI (sukut 2). Qayta urinish faqat bitta joyda —
 * ClaudeService ichida, truncation'da, bir marta. Aks holda bitta parse
 * 3 marta to'lanishi va RPC timeout'idan oshib ketishi mumkin.
 */
export const ANTHROPIC_MAX_RETRIES = 0;

/**
 * Sukut max_tokens. ⚠️ Yangi modellarda (Sonnet 5) thinking SUKUT BO'YICHA
 * YOQIQ va max_tokens thinking + javobni BIRGA qamraydi — BeePostdagi 1024
 * uzunroq matnni jimgina kesardi.
 */
export const CLAUDE_DEFAULT_MAX_TOKENS = 4000;

/** Truncation retry faqat muddatdan kamida shuncha vaqt qolganda qilinadi. */
export const CLAUDE_RETRY_MIN_BUDGET_MS = 15_000;

/** Bitta urinish uchun minimal qolgan vaqt — undan kam bo'lsa chaqirilmaydi. */
export const CLAUDE_MIN_ATTEMPT_BUDGET_MS = 10_000;

/**
 * Sukut modellar (env: AI_ORDER_MODEL, AI_ORDER_VISION_MODEL, AI_CLASSIFY_MODEL).
 * order === vision — matn va rasm chaqiruvlari BITTA prompt keshini bo'lishadi.
 */
export const AI_MODEL_DEFAULTS = {
  order: 'claude-sonnet-5',
  vision: 'claude-sonnet-5',
  classify: 'claude-haiku-4-5',
} as const;
