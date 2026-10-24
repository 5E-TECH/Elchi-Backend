/**
 * R6R8BLGA — skaner route'lari uchun YUQORIROQ per-IP limit.
 *
 * MUAMMO. Global limit (`ClientIpThrottlerGuard`, `THROTTLE_LIMIT` sukut
 * 60/daqiqa) har route uchun bitta IP bo'yicha sanaydi. Filialdagi barcha
 * telefon/kompyuterlar bitta tashqi IP'dan chiqadi: 2–3 xodim kamera bilan
 * ketma-ket skanerlasa `GET /scan/:token`, `POST /orders/receive` va
 * `POST /orders/scan-assign` 429 qaytarardi.
 *
 * YECHIM (kartadagi ikki variantdan minimal — "yuqoriroq @Throttle"): shu uch
 * route'da global 'default' throttler'ning limiti `SCAN_THROTTLE_LIMIT`
 * (sukut 300/daqiqa/IP — ~5 qurilma × 1 skan/soniya). Hisoblagich AVVALGIDEK
 * per-IP (`CF-Connecting-IP`) va har route o'zinikini sanaydi — anonim/
 * tokensiz trafik ham cheklangan qoladi (`@SkipThrottle` YO'Q).
 *
 * Limit global `THROTTLE_LIMIT` dan HECH QACHON past emas (prod'da global
 * qiymat oshirilgan bo'lsa, skaner route'lari undan qattiqroq bo'lib
 * qolmasin). Oyna — `SCAN_THROTTLE_TTL_MS`, bo'lmasa `THROTTLE_TTL_MS`.
 *
 * ⚠️ `@Throttle` metama'lumoti klass yuklanganda o'qiladi (Joi sukutidan
 * OLDIN, `authThrottleConfig` kabi) — shuning uchun to'g'ridan-to'g'ri
 * `process.env`; Joi sxemasidagi sukutlar shu yerdagi bilan AYNI.
 */
export const SCAN_THROTTLE_LIMIT_DEFAULT = 300;

/** Musbat butun son; bo'sh yoki noto'g'ri qiymatda — sukut. */
const positiveIntEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

export function scanThrottleConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const globalLimit = positiveIntEnv(env.THROTTLE_LIMIT, 60);
  const globalTtl = positiveIntEnv(env.THROTTLE_TTL_MS, 60_000);
  return {
    default: {
      limit: Math.max(
        positiveIntEnv(env.SCAN_THROTTLE_LIMIT, SCAN_THROTTLE_LIMIT_DEFAULT),
        globalLimit,
      ),
      ttl: positiveIntEnv(env.SCAN_THROTTLE_TTL_MS, globalTtl),
    },
  };
}

/** `@Throttle(SCAN_THROTTLE)` — skaner route'lari (R6R8BLGA). */
export const SCAN_THROTTLE = scanThrottleConfig();
