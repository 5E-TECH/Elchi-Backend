import { TASHKENT_OFFSET_MINUTES, parseDateOnly } from './tashkent-time';

/**
 * ISH KUNI — statistika, dashboard, kunlik hisobot, moliya kunlari, Excel va
 * kunlik pochtalar uchun YAGONA kun chegarasi (Trello xhiXv3w3).
 *
 * «Kun almashish soati» (Ops → «Kun tartibi», `order_schema.order_settings`
 * `intake.day_change_time`, sukut `00:00`) kunni belgilaydi. Masalan soat
 * `05:00` bo'lsa, «26-noyabr» ish kuni = 26-noyabr 05:00 → 27-noyabr 05:00
 * (Toshkent): 27-noyabr 00:59 va 01:30 dagi buyurtmalar 26-noyabrga tushadi.
 *
 * Ish kuni SANASI — oynaning ko'p qismi tushgan kalendar kuni (buyurtma qabuli
 * oynasidagi qoida, `order-intake.ts`): soat `12:00` dan oldin bo'lsa — o'sha
 * kun ertalabdan boshlanadi, `12:00` va undan keyin bo'lsa — kun KECHA
 * kechqurun boshlanadi (masalan `18:00`: «10-noyabr» = 9-noyabr 18:00 →
 * 10-noyabr 18:00).
 *
 * ⚠️ FAQAT OLDINGA (ega 2026-11-02, karta varianti 5a): soat o'zgarsa yangi
 * qoida keyingi kun almashishidan (`from`) amal qiladi, ESKI kunlar qayta
 * hisoblanmaydi. Shu sababli sozlama — qoidalar ro'yxati (`schedule`): har
 * kun o'zi tushgan qoida bilan boshlanadi, oxiri — keyingi kunning boshi.
 * O'tish kuni 24 soatdan uzun yoki qisqa bo'lishi mumkin (00:00 → 05:00:
 * o'tish kuni 29 soat), lekin kunlar orasida bo'shliq yoki ustma-ust yo'q.
 *
 * Sozlama butun kompaniya uchun BITTA (filial bo'yicha emas). Har servis uni
 * `BusinessDayModule` orqali daqiqada bir yangilaydi — qoida faqat kamida
 * `BUSINESS_DAY_MIN_LEAD_MS` keyin kuchga kiradi, ya'ni servislar hech qachon
 * eskirgan qoida bilan kun hisoblamaydi.
 *
 * Sukut (qoida yo'q) — Toshkent yarim tuni: hamma funksiya `tashkent-time.ts`
 * bilan AYNI natija beradi (dashboard raqamlari o'zgarmaydi).
 *
 * `tashkent-time.ts` KALENDAR kuni bo'lib qoladi — SMS / vaqtinchalik parol
 * kunlik limitlari, tungi jimlik soatlari, AI xarajat limiti kabi «ish»ga
 * emas, sutkaga bog'liq qoidalar uchun.
 */

/** `order_schema.order_settings.key` — ish kuni ham shu bitta kalitda. */
export const BUSINESS_DAY_SETTING_KEY = 'intake.day_change_time';

/** Sukut — Toshkent yarim tuni (hozirgi xatti-harakat). */
export const BUSINESS_DAY_DEFAULT_TIME = '00:00';

/** Servislar sozlamani shu oraliqda qayta o'qiydi (karta: ≤ 1 daqiqa). */
export const BUSINESS_DAY_REFRESH_MS = 60_000;

/**
 * Yangi qoida kamida shuncha keyin kuchga kiradi — daqiqalik yangilanishdan
 * katta zaxira (hamma servis oldindan biladi).
 */
export const BUSINESS_DAY_MIN_LEAD_MS = 5 * 60_000;

/** Bitta qoida: `from` ish kunidan boshlab kun `time` da almashadi. */
export interface BusinessDayRule {
  /** Shu qoida bo'yicha BOSHLANADIGAN birinchi ish kuni (`YYYY-MM-DD`). */
  from: string;
  /** Kun almashish soati, Toshkent `HH:MM`. */
  time: string;
}

/** `intake.day_change_time` qatorining DB'dagi shakli. */
export interface StoredBusinessDaySetting {
  /** Oxirgi o'rnatilgan soat (`HH:MM`). */
  time: string;
  /** `from` bo'yicha o'sib boruvchi, ixchamlangan qoidalar. */
  schedule?: BusinessDayRule[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;
const HALF_DAY_MINUTES = 12 * 60;
const OFFSET_MS = TASHKENT_OFFSET_MINUTES * MINUTE_MS;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Qat'iy `HH:MM` → daqiqalar, aks holda `null`. */
function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = CLOCK_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Haqiqiy kalendar sanasi `YYYY-MM-DD` ('2026-02-30' — yo'q). */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY_KEY_RE.exec(value);
  if (!match) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** Kun kalitiga `days` kun qo'shadi (manfiy — ayiradi). */
export function addDayKey(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Kun almashish soati → kalendar yarim tunidan siljish (daqiqa,
 * [-720, 720)): `05:00` → +300; `18:00` → −360 (kun kecha 18:00 da
 * boshlanadi); `12:00` → −720.
 */
function offsetOf(minutes: number): number {
  return minutes < HALF_DAY_MINUTES ? minutes : minutes - DAY_MINUTES;
}

interface CompiledRule {
  from: string;
  time: string;
  offset: number;
}

/**
 * Qoidalarni tozalaydi: yaroqsizlari tashlanadi, `from` bo'yicha tartiblanadi,
 * bir kunga ikkitasi bo'lsa — oxirgisi, oldingi kun bilan bir xil soat
 * (ortiqcha) — tashlanadi. Sukut (`00:00`) bilan boshlansa — u ham ortiqcha.
 */
export function normalizeBusinessDaySchedule(
  rules: unknown,
): BusinessDayRule[] {
  if (!Array.isArray(rules)) return [];
  const byDay = new Map<string, string>();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const from = (rule as { from?: unknown }).from;
    const minutes = clockMinutes((rule as { time?: unknown }).time);
    if (!isDayKey(from) || minutes === null) continue;
    byDay.set(from, formatMinutes(minutes));
  }
  const out: BusinessDayRule[] = [];
  let previous = BUSINESS_DAY_DEFAULT_TIME;
  for (const from of [...byDay.keys()].sort()) {
    const time = byDay.get(from) as string;
    if (time === previous) continue;
    out.push({ from, time });
    previous = time;
  }
  return out;
}

function formatMinutes(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function compile(rules: readonly BusinessDayRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    from: rule.from,
    time: rule.time,
    offset: offsetOf(clockMinutes(rule.time) ?? 0),
  }));
}

// ───────────────────── jarayon bo'yicha joriy jadval ─────────────────────

let activeRules: readonly BusinessDayRule[] = Object.freeze([]);
let activeCompiled: CompiledRule[] = [];

/** Joriy jadvalni almashtiradi (`BusinessDayModule`, testlar). */
export function setBusinessDaySchedule(rules: unknown): void {
  const normalized = normalizeBusinessDaySchedule(rules);
  activeRules = Object.freeze(normalized.map((rule) => ({ ...rule })));
  activeCompiled = compile(activeRules);
}

/** Joriy jadval (nusxa). */
export function getBusinessDaySchedule(): BusinessDayRule[] {
  return activeRules.map((rule) => ({ ...rule }));
}

function resolveRules(rules?: readonly BusinessDayRule[]): CompiledRule[] {
  return rules === undefined ? activeCompiled : compile(rules);
}

function ruleFor(
  dayKey: string,
  compiled: CompiledRule[],
): CompiledRule | null {
  let found: CompiledRule | null = null;
  for (const rule of compiled) {
    if (rule.from <= dayKey) found = rule;
    else break;
  }
  return found;
}

// ─────────────────────────── kun chegaralari ───────────────────────────

function startMs(dayKey: string, compiled: CompiledRule[]): number {
  const rule = ruleFor(dayKey, compiled);
  return (
    Date.parse(`${dayKey}T00:00:00.000Z`) -
    OFFSET_MS +
    (rule ? rule.offset : 0) * MINUTE_MS
  );
}

/** Ish kuni `dayKey` qaysi soatda boshlangan (`HH:MM`). */
export function businessDayChangeTimeFor(
  dayKey: string,
  rules?: readonly BusinessDayRule[],
): string {
  return (
    ruleFor(dayKey, resolveRules(rules))?.time ?? BUSINESS_DAY_DEFAULT_TIME
  );
}

/** Ish kuni `dayKey` ning boshi (UTC lahza). */
export function businessDayStart(
  dayKey: string,
  rules?: readonly BusinessDayRule[],
): Date {
  return new Date(startMs(dayKey, resolveRules(rules)));
}

/** Ish kuni `dayKey` ning oxiri — keyingi kun boshidan 1 ms oldin. */
export function businessDayEnd(
  dayKey: string,
  rules?: readonly BusinessDayRule[],
): Date {
  return new Date(startMs(addDayKey(dayKey, 1), resolveRules(rules)) - 1);
}

/** Lahza tushgan ish kunining sanasi (`YYYY-MM-DD`). */
export function businessDayKey(
  at: Date,
  rules?: readonly BusinessDayRule[],
): string {
  const compiled = resolveRules(rules);
  const t = at.getTime();
  // Siljish ±12 soatdan oshmaydi — ish kuni kalendar kunidan ko'pi bilan
  // bir kun farq qiladi; tsikllar ehtiyot uchun.
  let key = new Date(t + OFFSET_MS).toISOString().slice(0, 10);
  while (startMs(key, compiled) > t) key = addDayKey(key, -1);
  while (startMs(addDayKey(key, 1), compiled) <= t) key = addDayKey(key, 1);
  return key;
}

/** `at` tushgan ish kunining boshi. */
export function startOfBusinessDay(
  at: Date,
  rules?: readonly BusinessDayRule[],
): Date {
  return businessDayStart(businessDayKey(at, rules), rules);
}

/** `at` tushgan ish kunining oxiri (keyingi kun boshi − 1 ms). */
export function endOfBusinessDay(
  at: Date,
  rules?: readonly BusinessDayRule[],
): Date {
  return businessDayEnd(businessDayKey(at, rules), rules);
}

/** Ish haftasining boshi — dushanba ish kunining boshi. */
export function startOfBusinessWeek(
  at: Date,
  rules?: readonly BusinessDayRule[],
): Date {
  const key = businessDayKey(at, rules);
  const weekday = new Date(`${key}T00:00:00.000Z`).getUTCDay();
  return businessDayStart(addDayKey(key, -((weekday + 6) % 7)), rules);
}

/** Ish oyining boshi — oyning 1-ish kuni boshi. */
export function startOfBusinessMonth(
  at: Date,
  rules?: readonly BusinessDayRule[],
): Date {
  const key = businessDayKey(at, rules);
  return businessDayStart(`${key.slice(0, 7)}-01`, rules);
}

/** Ish oyining oxiri — keyingi oyning 1-ish kuni boshidan 1 ms oldin. */
export function endOfBusinessMonth(
  at: Date,
  rules?: readonly BusinessDayRule[],
): Date {
  const key = businessDayKey(at, rules);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return new Date(businessDayStart(next, rules).getTime() - 1);
}

function toBusinessBound(
  value: string | null | undefined,
  boundary: (dayKey: string) => Date,
): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  // Yaroqsiz qiymat o'zgarishsiz qaytadi — chaqiruvchi o'z 400 xabarini
  // tashlaydi (`tashkentDayRange` bilan bir xil).
  if (Number.isNaN(parsed.getTime())) return parsed;
  const dateOnly = parseDateOnly(value);
  return dateOnly ? boundary(dateOnly.toISOString().slice(0, 10)) : parsed;
}

/**
 * API sana filtri (`start_day`/`end_day`, `fromDate`/`toDate` …) — ISH KUNI
 * bo'yicha. `tashkentDayRange` bilan bir xil shartnoma:
 * - bo'sh → undefined; yaroqsiz → Invalid Date (chaqiruvchi 400);
 * - aniq `YYYY-MM-DD` → ish kunining boshi / oxiri;
 * - boshqa qiymat (to'liq ISO) → `new Date(v)` o'zgarishsiz.
 *
 * Soat `05:00` da: ('2026-11-26', '2026-11-26') →
 * [2026-11-26T00:00:00.000Z, 2026-11-27T00:00:00.000Z − 1 ms].
 */
export function businessDayRange(
  start?: string | null,
  end?: string | null,
  rules?: readonly BusinessDayRule[],
): { start?: Date; end?: Date } {
  return {
    start: toBusinessBound(start, (key) => businessDayStart(key, rules)),
    end: toBusinessBound(end, (key) => businessDayEnd(key, rules)),
  };
}

// ─────────────────────────────── SQL ───────────────────────────────

/**
 * SQL ifoda: `timestamptz` ustun (`column`) → Toshkent `timestamp`, uning
 * SANA qismi ish kuni sanasiga teng. Chaqiruvchi o'zi o'raydi:
 * `to_char(<ifoda>, 'YYYY-MM-DD')`, `(<ifoda>)::date`, `'YYYY-MM'` va h.k.
 * ⚠️ Soat qismi ma'nosiz (siljigan / o'tish kunida qisqartirilgan) — soatlik
 * bucket uchun ISHLATILMASIN.
 *
 * Qoida yo'q — aynan `(column AT TIME ZONE 'Asia/Tashkent')` (eski SQL).
 * Qiymatlar faqat tekshirilgan qoidalardan (sana/soat), foydalanuvchi matni
 * kirmaydi.
 */
export function businessDayLocalSql(
  column: string,
  rules?: readonly BusinessDayRule[],
): string {
  const compiled = resolveRules(rules);
  const local = `(${column} AT TIME ZONE 'Asia/Tashkent')`;
  if (!compiled.length) return local;
  const shifted = (offset: number) =>
    offset === 0 ? local : `(${local} - interval '${offset} minutes')`;
  // Segment i — [rule_i boshlanishi, rule_{i+1} boshlanishi). Oxirgi kun
  // keyingi qoida kunidan oldinda qolishi uchun sana yuqoridan cheklanadi
  // (00:00 → 05:00 o'tishida 01:30 hali eski kun).
  const segments = [
    { from: null as string | null, offset: 0 },
    ...compiled.map((rule) => ({ from: rule.from, offset: rule.offset })),
  ];
  const branches: string[] = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    let expr = shifted(segment.offset);
    if (next?.from) {
      expr = `LEAST(${expr}, TIMESTAMP '${addDayKey(next.from, -1)} 23:59:59.999999')`;
    }
    if (segment.from) {
      const start = new Date(startMs(segment.from, compiled)).toISOString();
      branches.push(`WHEN ${column} >= TIMESTAMPTZ '${start}' THEN ${expr}`);
    } else {
      branches.push(`ELSE ${expr}`);
    }
  }
  return `(CASE WHEN ${column} IS NULL THEN NULL ${branches.join(' ')} END)`;
}

/** `to_char(<ish kuni>, 'YYYY-MM-DD')` — kunlik bucket kaliti (matn). */
export function businessDayKeySql(
  column: string,
  rules?: readonly BusinessDayRule[],
): string {
  return `to_char(${businessDayLocalSql(column, rules)}, 'YYYY-MM-DD')`;
}

// ───────────────────── sozlama: o'qish va o'zgartirish ─────────────────────

/**
 * DB qiymati → qoidalar. `schedule` yo'q eski shakl (`{ time }`, xhiXv3w3
 * dan oldin) — qoida yo'q, ya'ni Toshkent yarim tuni: eski soat migratsiya
 * 1716000000251 da keyingi kun almashishidan qoidaga aylantirilgan.
 */
export function parseStoredBusinessDay(value: unknown): BusinessDayRule[] {
  if (!value || typeof value !== 'object') return [];
  return normalizeBusinessDaySchedule(
    (value as { schedule?: unknown }).schedule,
  );
}

/** Oxirgi o'rnatilgan soat (FE «Kun almashish soati» maydoni). */
export function configuredBusinessDayTime(
  rules: readonly BusinessDayRule[],
): string {
  return rules.length
    ? rules[rules.length - 1].time
    : BUSINESS_DAY_DEFAULT_TIME;
}

export interface BusinessDayChangePlan {
  /** Yangi qoidalar (saqlanadi). */
  schedule: BusinessDayRule[];
  /** Yangi soat bo'yicha boshlanadigan birinchi ish kuni. */
  effectiveFrom: string;
  /** O'sha kunning boshi — yangi soat birinchi marta ishlaydigan lahza. */
  effectiveAt: Date;
}

/**
 * Soatni `time` ga o'zgartirish rejasi (FAQAT OLDINGA): yangi qoida joriy ish
 * kunidan keyingi, boshlanishi `now + minLeadMs` dan kech bo'lgan birinchi
 * kundan amal qiladi. Joriy va o'tgan kunlar boshlanishi o'zgarmaydi; joriy
 * kun yangi chegarada TUGAYDI. Shu kundan keyingi kutilayotgan qoidalar
 * bekor qilinadi.
 *
 * Masalan soat `00:00`, 26-noyabr 14:00 da `05:00` qo'yildi → `from`
 * 27-noyabr: 26-noyabr ish kuni 00:00 → 27-noyabr 05:00.
 */
export function planBusinessDayChange(
  rules: readonly BusinessDayRule[],
  time: string,
  now: Date,
  minLeadMs: number = BUSINESS_DAY_MIN_LEAD_MS,
): BusinessDayChangePlan {
  const minutes = clockMinutes(time);
  if (minutes === null) throw new Error(`invalid business day time: ${time}`);
  const normalizedTime = formatMinutes(minutes);
  const current = normalizeBusinessDaySchedule(rules);
  const currentKey = businessDayKey(now, current);
  const earliest = now.getTime() + minLeadMs;
  const withRule = (from: string) => [
    ...current.filter((rule) => rule.from < from),
    { from, time: normalizedTime },
  ];
  let from = addDayKey(currentKey, 1);
  while (startMs(from, compile(withRule(from))) < earliest) {
    from = addDayKey(from, 1);
  }
  const candidate = withRule(from);
  return {
    schedule: normalizeBusinessDaySchedule(candidate),
    effectiveFrom: from,
    effectiveAt: new Date(startMs(from, compile(candidate))),
  };
}
