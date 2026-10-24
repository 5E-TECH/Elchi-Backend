import { WAREHOUSE_ERROR_CODES } from '../catalog/warehouse';

/**
 * (Elchi Pochta #3) Xato javobidagi mashina o'qiydigan qo'shimcha maydonlar.
 *
 * Gateway xato konverti doim `{ statusCode, message, trace_id? }` edi.
 * Ba'zi xatolarda FE matnni emas, aniq KODni tekshirishi kerak (masalan,
 * yangi sessiya boshqa sessiyalarni yopa olmaydi va qachondan mumkinligini
 * ko'rsatish kerak). Shunday xato servisda `code` (+ ruxsat etilgan
 * maydonlar) bilan tashlanadi:
 *
 *   throw new RpcException({ statusCode: 403, message, data: null,
 *     code: SESSION_TOO_NEW, available_at: '2026-10-25T07:00:00.000Z' });
 *
 * va gateway filtrlari javobga `code` va FAQAT shu kod uchun ro'yxatdagi
 * maydonlarni qo'shadi:
 *
 *   { statusCode: 403, message, code: 'SESSION_TOO_NEW',
 *     available_at: '…', trace_id? }
 *
 * RO'YXAT ATAYLAB YOPIQ: ro'yxatda yo'q `code` (Postgres `23505`, Node
 * `ECONNREFUSED`, kutubxona xatolari) va ro'yxatda yo'q maydonlar javobga
 * CHIQMAYDI — ichki tafsilot tasodifan FE'ga sizib chiqmasin. Qiymat faqat
 * oddiy tur (satr ≤256 / chekli son / boolean / null). Yangi kod — shu
 * jadvalga bitta qator.
 */
export const SESSION_TOO_NEW = 'SESSION_TOO_NEW';

export const PUBLIC_ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  // Sessiya yaratilganiga SESSION_REVOKE_LOCK_HOURS (sukut 48) to'lmagan:
  // `available_at` — qachondan boshqa sessiyalarni yopish mumkin (ISO).
  [SESSION_TOO_NEW]: ['available_at'],
  // (XtcEyQjb) to'xtatilgan omborga kirim — 409.
  [WAREHOUSE_ERROR_CODES.PAUSED]: [],
  // (XtcEyQjb) market operatoriga «Ombordagi qoldiq» yopiq — 403.
  [WAREHOUSE_ERROR_CODES.STOCK_FORBIDDEN]: [],
};

export type PublicErrorValue = string | number | boolean | null;

const MAX_STRING = 256;

function publicValue(value: unknown): PublicErrorValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_STRING ? value : undefined;
  }
  return undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Xato obyektidan (yoki ichidagi `response` / `error` obyektidan) javobga
 * chiqadigan `code` va uning ruxsat etilgan maydonlari. Ro'yxatda yo'q kod
 * yoki kodi yo'q xato → `{}` (konvert avvalgidek).
 */
export function publicErrorFields(
  error: unknown,
): Record<string, PublicErrorValue> {
  const root = asRecord(error);
  if (!root) return {};
  const candidates = [root, asRecord(root.response), asRecord(root.error)];
  for (const source of candidates) {
    if (!source) continue;
    const code = source.code;
    if (typeof code !== 'string') continue;
    const allowed = Object.prototype.hasOwnProperty.call(
      PUBLIC_ERROR_CODES,
      code,
    )
      ? PUBLIC_ERROR_CODES[code]
      : null;
    if (!allowed) continue;
    const fields: Record<string, PublicErrorValue> = { code };
    for (const key of allowed) {
      const value = publicValue(source[key]);
      if (value !== undefined) fields[key] = value;
    }
    return fields;
  }
  return {};
}

/**
 * (AF0fvJbw) Xato javobidagi `data` — servis xatoni sabab/son bilan
 * tashlasa (masalan, tuman o'chirishda 400:
 * `errorRes(msg, 400, { reason: 'district_in_use', usage: { orders: 5 } })`),
 * FE matnni tahlil qilmasdan oyna ko'rsatishi uchun. Gateway konvertiga
 * ixtiyoriy `data` qo'shiladi — FAQAT shu uch kalit:
 *
 *   - `reason`  — mashina kodi: `^[a-z][a-z0-9_]{0,63}$` (`district_in_use`);
 *     boshqa satr (inson matni, ID'li xabar) o'tmaydi;
 *   - `usage`   — tekis `{ kalit: son }` (sanoqlar), kalit ham mashina kodi;
 *   - `details` — tekis obyekt yoki (≤50 ta) tekis obyekt/oddiy qiymatlar
 *     ro'yxati; qiymat faqat oddiy tur (satr ≤256 / chekli son / boolean /
 *     null), kalit — mashina kodi. Ichma-ich obyekt tashlab yuboriladi.
 *     (tf324cXN) Istisno — `details` OBYEKT bo'lsa, uning qiymati (≤50 ta)
 *     oddiy qiymat/tekis obyektlar RO'YXATI ham bo'lishi mumkin (masalan
 *     tuman birlashtirishda `details.mismatches: [{ kind, district,
 *     expected, actual }]`); undan chuqurroq qism baribir tashlanadi.
 *
 * Boshqa kalitlar (`hint`, `post_id`, `blocked`, integratsiya javobi …) va
 * stack/ichki xabar javobga CHIQMAYDI. Hech biri qolmasa — `data` umuman
 * yo'q (konvert avvalgidek). Manba — faqat ataylab qurilgan xato: RPC xato
 * obyekti (`{ statusCode, message, data }`), `RpcException.getError()` yoki
 * `HttpException.getResponse()`; kutubxona xatolarining (axios
 * `response.data` va h.k.) ichiga qaralmaydi.
 */
export const PUBLIC_ERROR_DATA_KEYS = ['reason', 'usage', 'details'] as const;

export type PublicErrorDetailsItem =
  | PublicErrorValue
  | Record<string, PublicErrorValue>;

export type PublicErrorData = {
  reason?: string;
  usage?: Record<string, number>;
  details?:
    | Record<string, PublicErrorValue | PublicErrorDetailsItem[]>
    | PublicErrorDetailsItem[];
};

const MACHINE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ENTRIES = 50;

const isMachineKey = (key: string) => MACHINE_KEY_RE.test(key);

/** Tekis obyekt: faqat mashina kalitli, oddiy turdagi qiymatlar. */
function flatRecord<T>(
  value: unknown,
  pick: (item: unknown) => T | undefined,
): Record<string, T> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, T> = {};
  let count = 0;
  for (const key of Object.keys(record)) {
    if (count >= MAX_ENTRIES) break;
    if (!isMachineKey(key)) continue;
    const picked = pick(record[key]);
    if (picked === undefined) continue;
    out[key] = picked;
    count += 1;
  }
  return count ? out : undefined;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Oddiy qiymat / tekis obyektlar ro'yxati (≤50); bo'sh bo'lsa — `undefined`. */
function publicList(value: unknown[]): PublicErrorDetailsItem[] | undefined {
  const items: PublicErrorDetailsItem[] = [];
  for (const item of value.slice(0, MAX_ENTRIES)) {
    const primitive = publicValue(item);
    if (primitive !== undefined) {
      items.push(primitive);
      continue;
    }
    const record = flatRecord(item, publicValue);
    if (record) items.push(record);
  }
  return items.length ? items : undefined;
}

function publicDetails(value: unknown): PublicErrorData['details'] {
  if (Array.isArray(value)) return publicList(value);
  // (tf324cXN) obyekt qiymati — oddiy tur yoki tekis ro'yxat (bir daraja).
  return flatRecord(value, (item) =>
    Array.isArray(item) ? publicList(item) : publicValue(item),
  );
}

/**
 * Xato manbasidagi `data` dan javobga chiqadigan qism (yuqoridagi izoh).
 * `source` — RPC xato obyekti / `getError()` / `getResponse()`.
 */
export function publicErrorData(source: unknown): PublicErrorData | undefined {
  const data = asRecord(asRecord(source)?.data);
  if (!data) return undefined;
  const out: PublicErrorData = {};
  if (typeof data.reason === 'string' && isMachineKey(data.reason)) {
    out.reason = data.reason;
  }
  const usage = flatRecord(data.usage, finiteNumber);
  if (usage) out.usage = usage;
  const details = publicDetails(data.details);
  if (details) out.details = details;
  return Object.keys(out).length ? out : undefined;
}
