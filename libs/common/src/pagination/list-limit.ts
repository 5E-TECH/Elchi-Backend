/**
 * Tanlash ro'yxatlari (marketlar, kuryerlar, xodimlar, filiallar, market operatorlari) uchun `limit` ning yuqori
 * chegarasi.
 *
 * Nega: ilgari identity `normalizeQuery` va branch-service `normalizePagination` `limit` ni 100 bilan kesardi.
 * Frontend tanlash oynalari (masalan «To'lovlar → Berilishi kerak») `limit=10000` so'rab, qidiruvni yuklangan qatorlar
 * ichida qiladi — 101-market hech qachon chiqmasdi (qidiruvda ham). Chegara frontendning «to'liq ro'yxat»
 * qiymati (`FULL_LIST_LIMIT = 10000`) bilan bir xil. Sukut (`limit` berilmasa) — o'zgarmagan.
 */
export const LOOKUP_LIST_MAX_LIMIT = 10_000;

/**
 * `limit` ni normallashtiradi: musbat son bo'lsa — `max` gacha (butun qismi), aks holda `fallback`.
 * Noto'g'ri qiymat (`abc`, `0`, `-5`) — `fallback`.
 */
export const clampListLimit = (
  raw: unknown,
  fallback: number,
  max: number = LOOKUP_LIST_MAX_LIMIT,
): number => {
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
};
