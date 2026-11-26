import type {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { parseDateOnly } from '@app/common/time/tashkent-time';
import { toExcelDate } from '@app/report-kit';

/**
 * KASSA VA MOLIYA HISOBOTLARI (B1–B6) — yorliqlar va qiymat yordamchilari.
 * Matnlar frontend bilan bir xil (locales/uz/payments.json `v2Common.*`).
 * Enum'lar faqat TUR sifatida (kalitlar — qiymatlarning o'zi): `@app/common`
 * ni mock qiladigan eski spec'lar modulni yuklay olsin.
 */

/** RPC yukidagi primitiv → matn (obyekt, null, undefined — ''). */
export const asText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** Matn yoki `null` (bo'sh — katak bo'sh qolsin). */
export const textOrNull = (value: unknown): string | null =>
  asText(value).trim() || null;

/** Son yoki `null` (NULL / yaroqsiz — soxta 0 emas, bo'sh katak). */
export const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const toAmount = (value: unknown): number => numberOrNull(value) ?? 0;

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Pul tengligi (kasr xatosisiz). */
export const sameMoney = (a: number, b: number): boolean => round2(a - b) === 0;

/** `1234567` → «1 234 567» (izoh / eslatma matni uchun). */
export const moneyText = (value: number): string => {
  const rounded = round2(value);
  const [whole, fraction] = Math.abs(rounded).toString().split('.');
  return `${rounded < 0 ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${fraction ? `,${fraction}` : ''}`;
};

/** Excel'da son bo'lib turadigan ID (juda katta / raqam emas — matn). */
export const idValue = (value: unknown): number | string | null => {
  const raw = asText(value).trim();
  if (!raw) return null;
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : raw;
};

export const sumBy = <T>(
  rows: readonly T[],
  pick: (row: T) => number | null,
): number => round2(rows.reduce((total, row) => total + (pick(row) ?? 0), 0));

// ───────────────────────── yorliqlar ─────────────────────────

/** Yorliq; noma'lum (yangi) kod — o'zi. */
const labelOf = (labels: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(labels, key) ? labels[key] : key;

const OPERATION_LABEL: Readonly<Record<`${Operation_type}`, string>> = {
  income: 'Kirim',
  expense: 'Chiqim',
};
export const operationLabel = (value: unknown): string =>
  labelOf(OPERATION_LABEL, asText(value));

/** «Naqd» — Xulosa formulalari (SUMIFS) shu yorliq bo'yicha ajratadi. */
export const CASH_LABEL = 'Naqd';
const PAYMENT_METHOD_LABEL: Readonly<Record<`${PaymentMethod}`, string>> = {
  cash: CASH_LABEL,
  click: 'Karta (Click)',
  click_to_market: "Marketga o'tkazma",
};
export const paymentMethodLabel = (value: unknown): string =>
  labelOf(PAYMENT_METHOD_LABEL, asText(value));

const CASHBOX_SOURCE_LABEL: Readonly<Record<`${Source_type}`, string>> = {
  courier_payment: "Kuryer to'lovi",
  branch_to_main: "Filialdan HQ'ga o'tkazma",
  market_payment: "Market to'lovi",
  manual_income: "Qo'lda kirim",
  manual_expense: "Qo'lda chiqim",
  correction: 'Tuzatish',
  salary: 'Maosh',
  sell: 'Sotuv',
  cancel: 'Bekor qilish',
  extra_cost: "Qo'shimcha xarajat",
  bills: 'Hisob-fakturalar',
  payment_reversal: "To'lovni qaytarish",
  pickup_fee: 'Olib ketish haqi',
};

/**
 * Kassa tarixi manbasi (FE `getPaymentSourceTitle` bilan bir xil): filial
 * kassasida kuryer to'lovi — «Kuryerdan filialga o'tkazma»; `branch_to_main`
 * «Marketga o'tkazma» usulida — «Filialdan marketga o'tkazma».
 */
export const cashboxSourceLabel = (
  source: unknown,
  method?: unknown,
  cashboxType?: unknown,
): string => {
  const key = asText(source);
  if (key === 'courier_payment' && cashboxType === 'branch') {
    return "Kuryerdan filialga o'tkazma";
  }
  if (key === 'branch_to_main' && method === 'click_to_market') {
    return "Filialdan marketga o'tkazma";
  }
  return labelOf(CASHBOX_SOURCE_LABEL, key);
};

/** Buyurtma bo'yicha manbalar — `source_id` buyurtma raqami. */
const ORDER_SOURCES: ReadonlySet<string> = new Set([
  'sell',
  'cancel',
  'extra_cost',
]);
export const orderNumberOf = (
  source: unknown,
  sourceId: unknown,
): string | null => {
  const id = asText(sourceId).trim();
  return id && ORDER_SOURCES.has(asText(source)) ? `Buyurtma №${id}` : null;
};

export const MAIN_CASHBOX_NAME = 'Asosiy kassa';

/** Kassa turi bo'yicha nom (bir nechta kassa tanlanganda). */
const CASHBOX_TYPE_LABEL: Readonly<Record<`${Cashbox_type}`, string>> = {
  main: MAIN_CASHBOX_NAME,
  couriers: 'Kuryer kassalari',
  markets: 'Market kassalari',
  branch: 'Filial kassalari',
};
export const cashboxTypeLabel = (value: unknown): string =>
  labelOf(CASHBOX_TYPE_LABEL, asText(value));

export const branchLabel = (
  branchId: unknown,
  names: ReadonlyMap<string, string>,
): string => {
  const id = asText(branchId).trim();
  return names.get(id) ?? (id ? `Filial #${id}` : 'Filial');
};

// ───────────────────────── sana / davr ─────────────────────────

/** Lahza (ms); yaroqsiz / bo'sh — 0. */
export const timeOf = (value: unknown): number => {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return 0;
  }
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? 0 : at;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Lahza → «24.11.2026» (Toshkent). Yaroqsiz — ''. */
export const dateText = (value: unknown): string => {
  const d = toExcelDate(value);
  return d
    ? `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
    : '';
};

/** Lahza → «24.11.2026 09:15» (Toshkent). */
export const dateTimeText = (value: unknown): string => {
  const d = toExcelDate(value);
  return d
    ? `${dateText(value)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    : '';
};

/** Lahza → «2026-11-24» (Toshkent kuni; fayl nomi uchun). */
export const isoDayText = (value: unknown): string => {
  const d = toExcelDate(value);
  return d
    ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    : '';
};

/**
 * Davr chegarasi matni: 'YYYY-MM-DD' va kun chegarasidagi lahza — faqat sana,
 * boshqa aniq lahza — soati bilan.
 */
const boundText = (value: string, isEnd: boolean): string => {
  const day = parseDateOnly(value);
  if (day) {
    return `${pad(day.getUTCDate())}.${pad(day.getUTCMonth() + 1)}.${day.getUTCFullYear()}`;
  }
  const full = dateTimeText(value);
  if (!full) return value;
  return full.endsWith(isEnd ? ' 23:59' : ' 00:00') ? full.slice(0, 10) : full;
};

/** «18.11 — 24.11.2026», «24.11.2026», «18.11.2026 dan», «Butun davr». */
export const periodText = (from?: string, to?: string): string => {
  const a = from ? boundText(from, false) : '';
  const b = to ? boundText(to, true) : '';
  if (!a && !b) return 'Butun davr';
  if (!b) return `${a} dan`;
  if (!a) return `${b} gacha`;
  if (a === b) return a;
  // Bir yil ichida — birinchi sanada yil takrorlanmaydi.
  const short =
    a.length === 10 && b.length === 10 && a.slice(6) === b.slice(6)
      ? a.slice(0, 5)
      : a;
  return `${short} — ${b}`;
};
