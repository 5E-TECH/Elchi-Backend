/**
 * PR-D (A-5) — pul summalari uchun umumiy chegaralar (gateway DTO va
 * finance servisi bir xil qiymatni ishlatadi).
 */

/**
 * Pul summasining yuqori chegarasi (so'm): 1e13 = 10 trillion. JS double
 * tiyingacha ANIQ bo'lgan oraliqda (≈ 9e13 gacha); 1e15 da tiyin siljiydi
 * (`1e15 − 0.01` → `1e15`), 1e19 esa `numeric(20,2)` ni to'ldirib 500 berardi.
 */
export const MONEY_MAX = 1e13;

/**
 * `numeric(14,2)` ustunlar (maosh, investitsiya, foyda ulushi) — 1e12 dan
 * katta qiymat DB'da 500 berardi.
 */
export const MONEY_MAX_NUMERIC_14_2 = 999_999_999_999.99;

/** Chegarani xabarda o'qiladigan ko'rinishda: `10 000 000 000 000`. */
export function formatMoneyLimit(value: number): string {
  const [whole, fraction] = value.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction === '00' ? grouped : `${grouped},${fraction}`;
}

/**
 * Kiritilgan (parse qilingan) son ANIQ tiyinda: `Math.round(v*100)/100 === v`.
 * Butun so'mlar va «x.yz» satrlardan parse qilingan qiymatlar uchun soxta rad
 * yo'q (1e13 gacha); 1e-7, 0.009, 1.005, 0.1 + 0.2 — rad. Gateway kirishi
 * uchun (class-validator `maxDecimalPlaces` 1e-7 da TypeError → 500 berardi).
 */
export function isExactCents(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.round(value * 100) / 100 === value
  );
}

/**
 * HISOBLANGAN summa (masalan `collectible − tariff − share`) tiyinga yaqinmi:
 * tolerans 0,01 tiyin — 1e11 gacha float xatosi soxta rad bermaydi; 0,005,
 * 1,005, 100,001, 0,009 hali rad. ANIQ tiyindagi qiymat (`isExactCents`) doim
 * o'tadi. Finance ichki chaqiruvlari uchun.
 */
export function isNearCents(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  // Parse qilingan qiymat 1e13 gacha aniq (1e12..1e13 da tolerans yetmaydi).
  if (isExactCents(value)) return true;
  const cents = value * 100;
  return Math.abs(cents - Math.round(cents)) <= 1e-2;
}
