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
    // 5.5 avlodi (Anthropic narx jadvali, 2026-11): kesh o'qish 0.05×
    // (sonnet/opus) — AI_MODEL_CACHE_READ_MULTIPLIERS; haiku-5-5 100K
    // tokendan katta so'rovda qimmatroq tarif — AI_MODEL_LONG_PROMPT_PRICES.
    'opus-5-5': { in: 4, out: 20 },
    'sonnet-5-5': { in: 2, out: 10 },
    'haiku-5-5': { in: 0.1, out: 0.5 },
    'opus-5': { in: 5, out: 25 },
    // ⚠️ SAVOL (ega hisob-faktura bilan tasdiqlasin): Anthropic'ning joriy
    // jadvalida Sonnet 5 = $2/$10; bu yerda $3/$15 — ataylab o'zgartirilmadi.
    'sonnet-5': { in: 3, out: 15 },
    // Prod `.env.production` dagi AI_ORDER_MODEL (BeePost'dan qolgan) — jadval
    // tanimasa xarajat eng qimmat tarifda yozilardi (LP3RKvXY TC12). Ekstraksiya
    // uchun KUCHLI ro'yxatda EMAS: model_policy `weak` ko'rsatadi.
    'sonnet-4-6': { in: 3, out: 15 },
    'haiku-4-5': { in: 1, out: 5 },
    'fable-5': { in: 10, out: 50 },
  });

/**
 * Anthropic prompt caching — model bo'yicha MINIMAL keshlanadigan prefiks
 * (token). Undan qisqa prefiks `cache_control` bilan ham JIMGINA keshlanmaydi
 * (xato yo'q, shunchaki `cache_creation_input_tokens: 0`). ⚠️ Chegara avlod
 * bo'yicha monoton EMAS: haiku-4-5 = 4096, sonnet-5 / sonnet-4-6 = 1024,
 * opus-5 / fable-5 = 512 (5Z1ZvvzE #3). `AI_MODEL_PRICES` dagi har model uchun
 * shu yerda ham qiymat bo'lishi SHART (ai-pricing.spec).
 */
export const AI_MODEL_CACHE_MIN_TOKENS: Readonly<Record<string, number>> =
  Object.freeze({
    'opus-5-5': 512,
    'sonnet-5-5': 512,
    'haiku-5-5': 512,
    'opus-5': 512,
    'sonnet-5': 1024,
    'sonnet-4-6': 1024,
    'haiku-4-5': 4096,
    'fable-5': 512,
  });

/**
 * `output_config.effort` YUBORILADIGAN modellar (normallashtirilgan id) —
 * sukut bo'yicha ADAPTIVE thinking'li avlod. Boshqa modellarga kalit
 * BERILMAYDI: Haiku 4.5 effort'ni qabul qilmaydi (400), Sonnet 4.6 da
 * thinking sukut o'chiq, noma'lum model — xavf qilinmaydi. district-pick va
 * order-extract shu BITTA ro'yxatdan foydalanadi.
 */
export const AI_LOW_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'sonnet-5',
  'opus-5',
  'fable-5',
  // 5.5 avlodi: thinking O'CHIRILMAYDI (disabled/budget_tokens → 400) va
  // sukut effort baland (Sonnet 5.5 — high, Opus/Haiku 5.5 — medium).
  // Effort berilmasa kichik max_tokens thinking'ga ketib javob kesiladi —
  // shuning uchun HAR chaqiruv effort'ni aniq yuboradi (`effortParam`).
  'sonnet-5-5',
  'opus-5-5',
  'haiku-5-5',
]);

export type AiEffort = 'low' | 'medium' | 'high';

/**
 * Chaqiruvga qo'shiladigan `effort` qismi: model effort'ni qabul qilsa
 * `{ effort }`, aks holda `{}` (Haiku 4.5 — 400). Barcha chaqiruv joylari
 * shu BITTA funksiyadan foydalanadi (ai-effort.spec qulflaydi).
 */
export function effortParam(
  model: string,
  effort: AiEffort,
): { effort?: AiEffort } {
  return supportsEffort(model) ? { effort } : {};
}

/** Modelga `effort` yuborish mumkinmi (`AI_LOW_EFFORT_MODELS`). */
export function supportsEffort(model: string): boolean {
  return AI_LOW_EFFORT_MODELS.has(normalizeModelId(model));
}

/** Kesh chegarasi; noma'lum model → `null` (keshga tayanilmaydi). */
export function cacheMinTokensFor(model: string): number | null {
  const key = normalizeModelId(model);
  return Object.prototype.hasOwnProperty.call(AI_MODEL_CACHE_MIN_TOKENS, key)
    ? AI_MODEL_CACHE_MIN_TOKENS[key]
    : null;
}

/** Kesh yozish = kirish × 1.25 (Anthropic prompt caching, 5 daqiqa TTL). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** C1: 1 soatlik TTL bilan kesh yozish = kirish × 2. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;
/** Kesh o'qish (sukut) = kirish × 0.1 — ya'ni tejash kirish narxining 90%. */
export const CACHE_READ_MULTIPLIER = 0.1;

/** Sukutdan farq qiladigan kesh o'qish ko'paytiruvchilari (model bo'yicha). */
export const AI_MODEL_CACHE_READ_MULTIPLIERS: Readonly<Record<string, number>> =
  Object.freeze({
    'opus-5-5': 0.05,
    'sonnet-5-5': 0.05,
  });

/**
 * Uzun so'rov tarifi: kirish (kesh bilan birga) `threshold` tokendan oshsa
 * BUTUN so'rov shu narxda (Haiku 5.5: 100K dan ortiq — $0.50/$2.50).
 */
export const AI_MODEL_LONG_PROMPT_PRICES: Readonly<
  Record<string, { threshold: number; price: AiModelPrice }>
> = Object.freeze({
  'haiku-5-5': { threshold: 100_000, price: { in: 0.5, out: 2.5 } },
});

/** Model bo'yicha kesh o'qish ko'paytiruvchisi. */
export function cacheReadMultiplierFor(model: string): number {
  const key = normalizeModelId(model);
  return Object.prototype.hasOwnProperty.call(
    AI_MODEL_CACHE_READ_MULTIPLIERS,
    key,
  )
    ? AI_MODEL_CACHE_READ_MULTIPLIERS[key]
    : CACHE_READ_MULTIPLIER;
}

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
  /** C1: `cacheCreationTokens` dan 1 soatlik TTL bilan yozilgani. */
  cacheCreation1hTokens?: number;
}

/** Manfiy/NaN/kasr qiymatni butun nomanfiy songa keltiradi. */
export function safeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Kesh yozish tokenlari narx og'irligi bilan: 5 daqiqalik × 1.25, 1 soatlik
 * × 2 (1h qismi jami yozishdan oshmaydi).
 */
function cacheWriteTokensWeighted(u: AiTokenUsage): number {
  const total = safeTokenCount(u.cacheCreationTokens);
  const oneHour = Math.min(safeTokenCount(u.cacheCreation1hTokens), total);
  return (
    (total - oneHour) * CACHE_WRITE_MULTIPLIER +
    oneHour * CACHE_WRITE_1H_MULTIPLIER
  );
}

/** So'rov hajmini hisobga olgan narx (uzun so'rov tarifi bo'lsa — o'sha). */
function effectivePriceFor(u: AiTokenUsage): AiModelPrice {
  const key = normalizeModelId(u.model);
  const long = Object.prototype.hasOwnProperty.call(
    AI_MODEL_LONG_PROMPT_PRICES,
    key,
  )
    ? AI_MODEL_LONG_PROMPT_PRICES[key]
    : undefined;
  if (long) {
    const promptTokens =
      safeTokenCount(u.inputTokens) +
      safeTokenCount(u.cacheCreationTokens) +
      safeTokenCount(u.cacheReadTokens);
    if (promptTokens > long.threshold) return long.price;
  }
  return priceFor(u.model);
}

/**
 * Bitta javobning USD xarajati (yaxlitlanmagan):
 * in×input + out×output + in×1.25×cache_write + in×R×cache_read
 * (R — model bo'yicha, `cacheReadMultiplierFor`).
 */
export function computeCostUsd(u: AiTokenUsage): number {
  const p = effectivePriceFor(u);
  return (
    (safeTokenCount(u.inputTokens) * p.in +
      safeTokenCount(u.outputTokens) * p.out +
      cacheWriteTokensWeighted(u) * p.in +
      safeTokenCount(u.cacheReadTokens) *
        p.in *
        cacheReadMultiplierFor(u.model)) /
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
    (safeTokenCount(u.cacheReadTokens) *
      p.in *
      (1 - cacheReadMultiplierFor(u.model))) /
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
