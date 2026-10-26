import { TASHKENT_OFFSET_MINUTES } from '@app/common';

/**
 * qzjTMWPb — kunlik agregatlar uchun Toshkent kalendar kuni yordamchilari.
 *
 * Kun kaliti — `'YYYY-MM-DD'` (Toshkent, UTC+5, yozgi vaqt yo'q). Chegaralar
 * `tashkent-time.ts` dagi qoida bilan AYNI: kun 00:00:00.000 dan
 * 23:59:59.999 gacha (UTC sifatida qaytadi). Server TZ'iga bog'liq emas.
 */
const OFFSET_MS = TASHKENT_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Lahza tushgan Toshkent kunining kaliti. */
export function tashkentDayKey(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Aniq 'YYYY-MM-DD' (haqiqiy sana) bo'lsa — o'zi, aks holda null. */
export function parseDayKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = DAY_KEY_RE.exec(trimmed);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // '2026-02-30' kabi oydan oshgan kunlar rad etiladi (jim surilmaydi).
  return new Date(ms).toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

/** Kun kalitiga `days` kun qo'shadi (manfiy — ayiradi). */
export function addDays(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Toshkent kunining boshi (00:00:00.000) — UTC lahza. */
export function dayStart(dayKey: string): Date {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) - OFFSET_MS);
}

/** Toshkent kunining oxiri (23:59:59.999) — UTC lahza. */
export function dayEnd(dayKey: string): Date {
  return new Date(
    Date.parse(`${dayKey}T00:00:00.000Z`) + DAY_MS - OFFSET_MS - 1,
  );
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
