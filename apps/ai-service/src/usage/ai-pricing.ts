import { Logger } from '@nestjs/common';

/**
 * Anthropic narxlari — USD per 1M token (lYVuADRE 5-band, PLAN §5.25).
 *
 * ⚠️ BeePostda narx model nomidagi kalit so'z bo'yicha tanlanardi va
 * noma'lum model JIMGINA opus narxida (5/25) hisoblanardi — ya'ni fable-5
 * (10/50) ikki barobar KAM hisoblanardi. Bu yerda aniq map: noma'lum model
 * ENG QIMMAT tarifni oladi va WARN log beradi (past baholanmasin).
 *
 * ⚠️ Sonnet 5'ning $2/$10 kirish chegirmasi 2026-08-31 da tugagan — narxni
 * Anthropic konsolida ega tasdiqlasin.
 */
export interface AiModelPrice {
  /** Kirish tokeni, USD / 1M. */
  in: number;
  /** Chiqish tokeni, USD / 1M. */
  out: number;
}

export const AI_MODEL_PRICES: Readonly<Record<string, AiModelPrice>> =
  Object.freeze({
    'opus-5': { in: 5, out: 25 },
    'sonnet-5': { in: 3, out: 15 },
    'haiku-4-5': { in: 1, out: 5 },
    'fable-5': { in: 10, out: 50 },
  });

/** Kesh yozish = kirish × 1.25 (Anthropic prompt caching, 5 daqiqa TTL). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** Kesh o'qish = kirish × 0.1 — ya'ni tejash kirish narxining 90%. */
export const CACHE_READ_MULTIPLIER = 0.1;

const TOKENS_PER_UNIT = 1_000_000;

/** Noma'lum model uchun eng qimmat tarif (in va out alohida maksimum). */
const MAX_PRICE: AiModelPrice = Object.freeze({
  in: Math.max(...Object.values(AI_MODEL_PRICES).map((p) => p.in)),
  out: Math.max(...Object.values(AI_MODEL_PRICES).map((p) => p.out)),
});

const logger = new Logger('AiPricing');
/** Har noma'lum model nomi uchun WARN faqat BIR marta (log toshqini yo'q). */
const warnedUnknownModels = new Set<string>();

/**
 * Model id'ni narx map kalitiga keltiradi: `claude-` prefiksi va oxiridagi
 * `-YYYYMMDD` sana suffiksi olib tashlanadi.
 * 'claude-haiku-4-5-20251001' → 'haiku-4-5'; 'claude-sonnet-5' → 'sonnet-5'.
 */
export function normalizeModelId(model: string): string {
  return (typeof model === 'string' ? model : '')
    .trim()
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

/** Model narxi; noma'lum model → eng qimmat tarif + bir martalik WARN. */
export function priceFor(model: string): AiModelPrice {
  const key = normalizeModelId(model);
  const known = Object.prototype.hasOwnProperty.call(AI_MODEL_PRICES, key)
    ? AI_MODEL_PRICES[key]
    : undefined;
  if (known) return known;
  const label = key || "(bo'sh)";
  if (!warnedUnknownModels.has(label)) {
    warnedUnknownModels.add(label);
    logger.warn(
      `ai_unknown_model_price model=${label} — eng qimmat tarif qo'llandi ` +
        `(in=${MAX_PRICE.in}, out=${MAX_PRICE.out} USD/1M); AI_MODEL_PRICES ga qo'shing`,
    );
  }
  return MAX_PRICE;
}

/** Xarajat hisobi uchun tokenlar (`ClaudeUsageRecord` shu shaklga mos). */
export interface AiTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Manfiy/NaN/kasr qiymatni butun nomanfiy songa keltiradi. */
export function safeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Bitta javobning USD xarajati (yaxlitlanmagan):
 * in×input + out×output + in×1.25×cache_write + in×0.1×cache_read.
 */
export function computeCostUsd(u: AiTokenUsage): number {
  const p = priceFor(u.model);
  return (
    (safeTokenCount(u.inputTokens) * p.in +
      safeTokenCount(u.outputTokens) * p.out +
      safeTokenCount(u.cacheCreationTokens) * p.in * CACHE_WRITE_MULTIPLIER +
      safeTokenCount(u.cacheReadTokens) * p.in * CACHE_READ_MULTIPLIER) /
    TOKENS_PER_UNIT
  );
}

/**
 * Prompt caching tejagan summa (USD) — dashboard uchun:
 * cache_read × in × 0.9 / 1M (keshsiz narx minus kesh o'qish narxi).
 */
export function computeCacheSavedUsd(
  u: Pick<AiTokenUsage, 'model' | 'cacheReadTokens'>,
): number {
  const p = priceFor(u.model);
  return (
    (safeTokenCount(u.cacheReadTokens) * p.in * (1 - CACHE_READ_MULTIPLIER)) /
    TOKENS_PER_UNIT
  );
}

/** numeric(…,6) ustun uchun 6 kasrgacha yaxlitlash (USD). */
export function roundUsd(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}

/** numeric(…,2) ustun uchun 2 kasrgacha yaxlitlash (so'm, kurs). */
export function roundMoney2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
