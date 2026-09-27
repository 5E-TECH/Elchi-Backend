/**
 * Toshkent kun-bucketi — AI xarajati va global kunlik shift uchun YAGONA
 * sana qoidasi (lYVuADRE #12/#23, wFSMEIIy #11/#18).
 *
 * ⚠️ O'zbekiston 1991 yildan beri doimiy UTC+5 (yozgi vaqt YO'Q) — shuning
 * uchun JS tomonda sobit +5 soat siljish ishlatiladi (server TZ'iga
 * bog'liq emas). SQL tomonda esa `AT TIME ZONE 'Asia/Tashkent'` — ikkalasi
 * bir xil natija beradi (pg spec tasdiqlaydi).
 *
 * Toshkent 23:30 (UTC 18:30) va 00:30 (UTC 19:30) — TURLI kunlar.
 */

/** Toshkentning UTC'dan siljishi (ms). */
export const TASHKENT_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

/** ISO satrdagi Toshkent siljishi. */
export const TASHKENT_OFFSET_ISO = '+05:00';

/**
 * `ai_usage_log` qatorini Toshkent sanasiga bog'laydigan SQL ifoda.
 * ⚠️ Kun bo'yicha agregat SQL'i FAQAT shu konstanta orqali yoziladi.
 */
export const TASHKENT_DAY_SQL = `("createdAt" AT TIME ZONE 'Asia/Tashkent')::date`;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Berilgan vaqtning Toshkent sanasi (YYYY-MM-DD) — `period_key`. */
export function tashkentDay(d: Date = new Date()): string {
  return new Date(d.getTime() + TASHKENT_UTC_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** Haqiqiy kalendar sanasi (YYYY-MM-DD)? '2026-02-31' → false. */
export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !YMD_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** YYYY-MM-DD sanaga `days` kun qo'shadi (manfiy ham bo'ladi). */
export function addDaysYmd(ymd: string, days: number): string {
  const base = new Date(`${ymd}T00:00:00Z`).getTime();
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** Toshkent sanasining boshlanishi — ISO satr `YYYY-MM-DDT00:00:00+05:00`. */
export function tashkentDayStartIso(ymd: string): string {
  return `${ymd}T00:00:00${TASHKENT_OFFSET_ISO}`;
}

/**
 * Keyingi Toshkent yarim tuni — kunlik shift shu paytda nolga tushadi
 * (`reset_at`). HAR DOIM `d` dan keyin (kelajakda).
 */
export function nextTashkentMidnight(d: Date = new Date()): string {
  return tashkentDayStartIso(addDaysYmd(tashkentDay(d), 1));
}
