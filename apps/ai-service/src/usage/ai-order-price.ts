import type { ConfigService } from '@nestjs/config';

/**
 * NFiXfmq6 — AI buyurtma NARXI (mijozdan olinadigan, so'm) qoidasi.
 *
 * Ega qarori (2026-09-19): "default 300 so'm, firma kesimida o'zgaruvchan".
 *  - Global: `AI_PRICE_PER_ORDER` (env). Berilmasa eski `AI_ORDER_PRICE_UZS`,
 *    u ham bo'lmasa 300.
 *  - Market: `admins.ai_price_per_order` — NULL bo'lsa global; 0 — bepul.
 *  - Amal qilgan narx har AI buyurtmaga (`ai_order_draft_item.applied_price_uzs`)
 *    muzlatiladi — narx o'zgarsa eski yozuvlar qayta hisoblanmaydi.
 *
 * Narx (biznes qarori) va real xarajat (`ai_usage_log.cost_uzs`, token)
 * ATAYLAB ajratilgan — ular faqat marja hisobotida bir ekranda uchrashadi.
 */
export const DEFAULT_AI_PRICE_PER_ORDER_UZS = 300;

function money2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Nomanfiy chekli son bo'lsa — o'sha (2 xona), aks holda null. */
export function priceOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? money2(n) : null;
}

/**
 * Global narx: AI_PRICE_PER_ORDER → AI_ORDER_PRICE_UZS → 300.
 * Yaroqsiz (manfiy/son emas) qiymat e'tiborsiz qoldiriladi (Joi baribir
 * boot'da to'xtatadi; bu — spec/qo'lda qurilgan config uchun to'r).
 */
export function globalAiOrderPriceUzs(
  config: Pick<ConfigService, 'get'>,
): number {
  return (
    priceOrNull(config.get<unknown>('AI_PRICE_PER_ORDER')) ??
    priceOrNull(config.get<unknown>('AI_ORDER_PRICE_UZS')) ??
    DEFAULT_AI_PRICE_PER_ORDER_UZS
  );
}

/**
 * Market uchun amal qiladigan narx: market qiymati (0 ham — bepul) yoki,
 * u bo'sh/yaroqsiz bo'lsa, global narx.
 */
export function effectiveAiOrderPriceUzs(
  marketOverride: unknown,
  globalPriceUzs: number,
): number {
  return priceOrNull(marketOverride) ?? money2(globalPriceUzs);
}
