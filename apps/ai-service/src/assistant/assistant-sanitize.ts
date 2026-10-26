import { maskPhonesForLog } from '@app/common';

/**
 * F7PWp6cK — tool natijasini modelga (Anthropic, AQSh) yuborishdan OLDINGI
 * oxirgi himoya qatlami. Har tool o'zi faqat kerakli maydonlarni oladi
 * (projection); bu funksiya ustidan yana:
 *  - PII kalitlarini TASHLAYDI (telefon, manzil, parol, token, karta egasi…);
 *  - qolgan matnlardagi telefon raqamlarini maskalaydi;
 *  - uzun matnni 160 belgigacha qisqartiradi;
 *  - massivni 50 ta elementgacha, chuqurlikni 6 gacha cheklaydi.
 */

const PII_KEY_RE =
  /(phone|telefon|tel_|_tel$|^tel$|passport|password|parol|token|secret|holder|card_number|cardnumber|pan$|address|manzil|email|telegram|chat_id|ip_address|user_agent|comment|izoh|note$)/i;

const MAX_STRING = 160;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

export function sanitizeForModel(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const masked = maskPhonesForLog(value);
    return masked.length > MAX_STRING
      ? `${masked.slice(0, MAX_STRING)}…`
      : masked;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitizeForModel(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEY_RE.test(key)) continue;
      if (typeof v === 'function') continue;
      out[key] = sanitizeForModel(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** Tool natijasi JSON'ining maksimal hajmi (belgi) — token sarfini cheklaydi. */
export const ASSISTANT_TOOL_RESULT_MAX_CHARS = 12_000;

/**
 * Hajm chegarasi: oshsa eng katta massivlar 5 tagacha qisqartiriladi va
 * `_truncated: true` qo'yiladi; baribir oshsa — faqat skalyar maydonlar.
 */
export function capResultSize(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  truncated: boolean;
} {
  if (JSON.stringify(data).length <= ASSISTANT_TOOL_RESULT_MAX_CHARS) {
    return { data, truncated: false };
  }
  const shrink = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) return v.slice(0, 5).map((x) => shrink(x, depth + 1));
    if (v && typeof v === 'object' && depth < MAX_DEPTH) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        o[k] = shrink(x, depth + 1);
      }
      return o;
    }
    return v;
  };
  const shrunk = {
    ...(shrink(data, 0) as Record<string, unknown>),
    _truncated: true,
  };
  if (JSON.stringify(shrunk).length <= ASSISTANT_TOOL_RESULT_MAX_CHARS) {
    return { data: shrunk, truncated: true };
  }
  const scalars: Record<string, unknown> = { _truncated: true };
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v !== 'object') scalars[k] = v;
  }
  return { data: scalars, truncated: true };
}
