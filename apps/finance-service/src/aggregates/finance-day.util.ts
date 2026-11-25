import {
  addDayKey,
  businessDayEnd,
  businessDayKey,
  businessDayStart,
  isDayKey,
} from '@app/common';

/**
 * qzjTMWPb — kunlik agregatlar uchun kun yordamchilari.
 *
 * Kun kaliti — `'YYYY-MM-DD'` ISH KUNI sanasi (xhiXv3w3). Alohida qoida YO'Q:
 * hammasi `@app/common` `time/business-day.ts` dan (kun almashish soati,
 * sukut Toshkent 00:00 — 00:00:00.000 → 23:59:59.999). Soat o'zgarsa yangi
 * chegara faqat keyingi kunlardan — saqlangan snapshot'lar qayta
 * hisoblanmaydi. Server TZ'iga bog'liq emas.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Lahza tushgan ish kunining kaliti. */
export function tashkentDayKey(date: Date): string {
  return businessDayKey(date);
}

/** Aniq 'YYYY-MM-DD' (haqiqiy sana) bo'lsa — o'zi, aks holda null. */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // '2026-02-30' kabi oydan oshgan kunlar rad etiladi (jim surilmaydi).
  return isDayKey(trimmed) ? trimmed : null;
}

/** Kun kalitiga `days` kun qo'shadi (manfiy — ayiradi). */
export function addDays(dayKey: string, days: number): string {
  return addDayKey(dayKey, days);
}

/** Ish kunining boshi — UTC lahza. */
export function dayStart(dayKey: string): Date {
  return businessDayStart(dayKey);
}

/** Ish kunining oxiri (keyingi kun boshi − 1 ms) — UTC lahza. */
export function dayEnd(dayKey: string): Date {
  return businessDayEnd(dayKey);
}

/** [from, to] oralig'idagi barcha kun kalitlari (ikkala chet ham kiradi). */
export function dayKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let key = from; key <= to; key = addDays(key, 1)) keys.push(key);
  return keys;
}

/** Ikki kun kaliti orasidagi kunlar soni (`to − from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

/** Pul qiymati — 2 xonagacha yaxlitlangan son (numeric satr ham qabul). */
export function money(value: unknown): number {
  const num = Number(value ?? 0);
  // `|| 0` — −0 ni 0 ga (JSON va taqqoslashda chalg'itmasin).
  return Number.isFinite(num) ? Math.round(num * 100) / 100 || 0 : 0;
}

/** NULL saqlanadigan pul qiymati (snapshot'da noma'lum ≠ 0). */
export function moneyOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 || 0 : null;
}
