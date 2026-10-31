import { PAYMENT_CORRECTION_ERROR_CODES as PC } from '../finance/payment-correction';
import { CASHBOX_RECEIPT_ERROR_CODES as RC } from '../finance/cashbox-receipt';
import { WAREHOUSE_ERROR_CODES } from '../catalog/warehouse';
import { CONTACT_ERROR_CODES } from '../contacts/contacts';
import { SPECIAL_CATEGORIES_ERROR_CODES } from '../order/order-special-categories';
import { PARTNER_MARKET_ERROR_CODES } from '../integration/partner-markets';
import { IDEMPOTENCY_ERROR_CODES } from '../idempotency/idempotency-error-codes';

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
/**
 * (NDmZMzCP) Gateway sessiya holatini identity'dan bila olmadi — 503
 * (fail closed). 401 EMAS: FE foydalanuvchini chiqarib yubormaydi.
 */
export const SESSION_CHECK_UNAVAILABLE = 'SESSION_CHECK_UNAVAILABLE';
/**
 * (NDmZMzCP) Telefon (+IP) bo'yicha ketma-ket xato login — vaqtinchalik qulf,
 * 429. `retry_after_seconds` — qachon qayta urinish mumkin.
 */
export const LOGIN_LOCKED = 'LOGIN_LOCKED';
/**
 * (NDmZMzCP / aidsxJ2H) Parolni almashtirish shart — token faqat parol
 * almashtirish oqimiga ruxsat beradi (gateway `PASSWORD_CHANGE_GATE=on`), 403.
 */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';
/**
 * (BOT-2 #2) Telegram Mini App tokeni (`POST /auth/telegram`) faqat kuryerga
 * beriladi — boshqa rol 403.
 */
export const TELEGRAM_COURIER_ONLY = 'TELEGRAM_COURIER_ONLY';
/**
 * (BOT-2 #2) Telegram Mini App tokenining `scope` claim'i — gateway u bilan
 * faqat skan oqimini (`POST /orders/scan-assign`, `POST /telegram/scan/done`)
 * o'tkazadi.
 */
export const TELEGRAM_SCAN_SCOPE = 'tg_scan';
/**
 * (aidsxJ2H) O'z parolini almashtirishda joriy (eski) parol berilmagan /
 * noto'g'ri — 400 (401 EMAS: FE foydalanuvchini chiqarib yubormasin).
 */
export const OLD_PASSWORD_REQUIRED = 'OLD_PASSWORD_REQUIRED';
export const OLD_PASSWORD_INVALID = 'OLD_PASSWORD_INVALID';
/**
 * (aidsxJ2H) Vaqtinchalik parol SMS'ini qayta yuborish chegarasi — 429:
 * 60 soniyada bir marta (`PASSWORD_SMS_COOLDOWN`) va kuniga 5 marta
 * (`PASSWORD_SMS_DAILY_LIMIT`); `retry_after_seconds` — qachon mumkin.
 */
export const PASSWORD_SMS_COOLDOWN = 'PASSWORD_SMS_COOLDOWN';
export const PASSWORD_SMS_DAILY_LIMIT = 'PASSWORD_SMS_DAILY_LIMIT';

export const PUBLIC_ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  // (BOT-3d) kuryer amali Idempotency-Key: boshqa amal/buyurtma/tana — 422;
  // ayni kalitli so'rov hali bajarilmoqda — 409.
  [IDEMPOTENCY_ERROR_CODES.KEY_MISMATCH]: [],
  [IDEMPOTENCY_ERROR_CODES.IN_PROGRESS]: [],
  // (T6) to'lovni qaytarish / summasini tuzatish — superadmin.
  [PC.NOT_FOUND]: [],
  // `reason`: unsupported_type | reversal_row | cashbox_deleted (iPlY5yop).
  [PC.NOT_CORRECTABLE]: ['reason'],
  [PC.LEGACY_UNLINKED]: [],
  [PC.ALREADY_CORRECTED]: [],
  // Muddat o'tgan: `deadline` — qachongacha tuzatish mumkin edi (ISO),
  // `window_days` — amaldagi sozlama.
  [PC.WINDOW_EXPIRED]: ['deadline', 'window_days'],
  [PC.SHIFT_REQUIRED]: [],
  [PC.BRANCH_SHIFT_REQUIRED]: [],
  // `required` — kassa (usul / karta) qoldig'ida kerak bo'lgan summa.
  [PC.INSUFFICIENT_BALANCE]: ['required'],
  [PC.CARD_ARCHIVED]: [],
  [PC.SAME_AMOUNT]: [],
  // Yangi summa chegarasi: `max` (kuryer qoldig'i + X; market qarzi + X).
  [PC.AMOUNT_EXCEEDS]: ['max'],
  [PC.IDEMPOTENCY_KEY_REUSED]: [],
  [PC.IDEMPOTENCY_KEY_REQUIRED]: [],
  [PC.PAYMENT_CORRECTED]: [],
  [PC.COURIER_MOVED]: [],
  // Sessiya yaratilganiga SESSION_REVOKE_LOCK_HOURS (sukut 48) to'lmagan:
  // `available_at` — qachondan boshqa sessiyalarni yopish mumkin (ISO).
  [SESSION_TOO_NEW]: ['available_at'],
  // (NDmZMzCP) identity javob bermadi — 503, qayta urinish (chiqish emas).
  [SESSION_CHECK_UNAVAILABLE]: [],
  // (NDmZMzCP) login qulfi — 429, qancha soniyadan keyin urinish mumkin.
  [LOGIN_LOCKED]: ['retry_after_seconds'],
  // (NDmZMzCP) zaif/vaqtinchalik parol — avval parolni almashtirish, 403.
  [PASSWORD_CHANGE_REQUIRED]: [],
  // (BOT-2) Telegram Mini App tokeni faqat kuryerga — 403.
  [TELEGRAM_COURIER_ONLY]: [],
  // (aidsxJ2H) o'z parolini almashtirish — eski parol yo'q / noto'g'ri, 400.
  [OLD_PASSWORD_REQUIRED]: [],
  [OLD_PASSWORD_INVALID]: [],
  // (aidsxJ2H) parol SMS'ini qayta yuborish chegarasi — 429.
  [PASSWORD_SMS_COOLDOWN]: ['retry_after_seconds'],
  [PASSWORD_SMS_DAILY_LIMIT]: ['retry_after_seconds'],
  // (XtcEyQjb) to'xtatilgan omborga kirim — 409.
  [WAREHOUSE_ERROR_CODES.PAUSED]: [],
  // (XtcEyQjb) market operatoriga «Ombordagi qoldiq» yopiq — 403.
  [WAREHOUSE_ERROR_CODES.STOCK_FORBIDDEN]: [],
  // (VkKDSNNn) Markaziy ombor buyurtmasi marketga topshirilmaydi — 409.
  [WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK]: [],
  // (T7 QPq2C1co) aloqa sozlamalari va market mas'uli — 400.
  [CONTACT_ERROR_CODES.SUPPORT_PHONES_INVALID]: [],
  [CONTACT_ERROR_CODES.RESPONSIBLE_ROLE_INVALID]: [],
  [CONTACT_ERROR_CODES.RESPONSIBLE_INACTIVE]: [],
  [CONTACT_ERROR_CODES.NOT_A_MARKET]: [],
  // (T8 0OUcHZ7R) maxsus belgi bu holatda o'zgarmaydi — 409.
  [SPECIAL_CATEGORIES_ERROR_CODES.LOCKED]: [],
  // (T1 K1 s6xY4f5C) hamkor sotuvchisi / market allaqachon bog'langan — 409.
  [PARTNER_MARKET_ERROR_CODES.SELLER_TAKEN]: [],
  [PARTNER_MARKET_ERROR_CODES.MARKET_TAKEN]: [],
  // (T3 QlLf33Ma) kassa cheki — sozlama, yuklash, bog'lash, AI.
  ...Object.fromEntries(
    Object.values(RC).map((code) => [code, [] as readonly string[]]),
  ),
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
  PublicErrorValue | Record<string, PublicErrorValue>;

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
