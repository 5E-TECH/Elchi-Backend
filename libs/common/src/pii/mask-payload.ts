import { maskPhonesForLog } from './mask-phones';

/**
 * JSON PAYLOAD'NI KO'RSATISH UCHUN MASKALASH (Xd88lHGq).
 *
 * Kiruvchi webhook tanasida mijoz telefoni, ismi va manzili bor — Elchi uni
 * ATAYLAB ekranga qaytarmasdi. Operatorga esa "webhook nega yiqildi?" degan
 * savolga javob kerak: tuzilma, holat, id'lar. Bu util tuzilmani saqlab,
 * shaxsiy ma'lumotni yashiradi:
 *
 *   telefon  → `***7434` (oxirgi 4 raqam)
 *   ism      → bosh harflar (`A. V.`)
 *   manzil   → shahar/tuman darajasi (birinchi bo'lak + `***`)
 *   email    → `a***@domen`
 *
 * Kalit nomi bo'yicha aniqlanadi; boshqa satrlardagi telefon nomzodlari ham
 * `maskPhonesForLog` bilan yashiriladi. Hudud kalitlari (region, district,
 * city, viloyat, tuman) TEGILMAYDI — ular tashxis uchun kerak.
 *
 * ⚠️ Kirish o'zgartirilmaydi — har doim yangi qiymat qaytadi. Juda chuqur
 * yoki aylanma tuzilma `[chuqur]` bilan kesiladi.
 */

// `tel` faqat butun bo'lak sifatida — "hotel", "details" ushlanmasin.
const PHONE_KEY = /(phone|(^|_)tel($|_)|mobile|msisdn|telefon)/i;
const NAME_KEY =
  /^(name|full_?name|first_?name|last_?name|middle_?name|fio|customer_?name|recipient_?name|receiver_?name|sender_?name|contact_?name|client_?name|ism|familiya)$/i;
// `uy` faqat butun kalit — "buyurtma_id", "buyer" ushlanmasin.
const ADDRESS_KEY =
  /(address|street|house|apartment|flat|building|entrance|landmark|manzil|ko'?cha|^uy$|kvartira|location|coordinates|latitude|longitude|^lat$|^lng$|^lon$)/i;
const EMAIL_KEY = /e-?mail/i;
const REGION_KEY = /(region|district|city|viloyat|tuman|shahar|country)/i;

const MAX_DEPTH = 20;

/** Faqat skalyar matnga aylanadi — obyekt "[object Object]" bo'lib ketmasin. */
const asText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

export function maskPhoneTail(value: unknown): string {
  const digits = asText(value).replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

export function maskNameToInitials(value: unknown): string {
  const parts = asText(value).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.map((part) => `${part.charAt(0).toUpperCase()}.`).join(' ');
}

export function maskAddressToArea(value: unknown): string {
  const text = asText(value).trim();
  if (!text) return '';
  const first = text.split(/[,;]/)[0]?.trim() ?? '';
  // Birinchi bo'lak ko'cha/uy raqamini o'z ichiga olsa — umuman ko'rsatilmaydi.
  return first && !/\d/.test(first) ? `${first}, ***` : '***';
}

function maskEmail(value: unknown): string {
  const text = asText(value);
  const at = text.indexOf('@');
  return at > 0 ? `${text.charAt(0)}***${text.slice(at)}` : '***';
}

function maskScalarByKey(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return undefined;
  if (REGION_KEY.test(key) && !ADDRESS_KEY.test(key)) {
    return value;
  }
  if (PHONE_KEY.test(key)) return maskPhoneTail(value);
  if (EMAIL_KEY.test(key)) return maskEmail(value);
  if (NAME_KEY.test(key)) return maskNameToInitials(value);
  if (ADDRESS_KEY.test(key)) {
    return typeof value === 'number' ? '***' : maskAddressToArea(value);
  }
  return typeof value === 'string' ? maskPhonesForLog(value) : value;
}

export function maskPiiPayload<T = unknown>(input: T): T {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, key: string, depth: number): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') {
      return key ? maskScalarByKey(key, value) : value;
    }
    if (depth >= MAX_DEPTH || seen.has(value)) return '[chuqur]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, key, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[childKey] = walk(childValue, childKey, depth + 1);
    }
    return out;
  };
  return walk(input, '', 0) as T;
}
