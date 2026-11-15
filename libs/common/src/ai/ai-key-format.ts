import { createHash } from 'node:crypto';

/**
 * Anthropic API kaliti formati va erkin matn qoidalari (spec §4.1, §4.6;
 * be-brief D8/D9). FE (`src/entities/ai-config/validation.ts`), Joi va
 * ai-service AYNAN shu qoidalarni ishlatadi — jadvalli test ikkala tomonda
 * bir xil.
 *
 * ⚠️ MAXFIYLIK: bu yerdagi hech bir funksiya kalit qiymatini xato matniga,
 * logga yoki natijaga qo'ymaydi — faqat kod, `hint` (oxirgi 4 belgi) va
 * `fingerprint` (SHA-256 ning 12 hex belgisi).
 */
export const AI_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;
export const AI_KEY_MIN_LENGTH = 40;
export const AI_KEY_MAX_LENGTH = 256;

export type AiKeyFormatCode =
  'AI_KEY_FORMAT' | 'AI_KEY_ADMIN_KEY' | 'AI_KEY_OAUTH_TOKEN';

export type AiKeyFormatResult =
  { ok: true; key: string } | { ok: false; code: AiKeyFormatCode };

/**
 * Kalitni tekshiradi: boshi/oxiridagi bo'shliq olib tashlanadi, keyin
 * prefiks (admin / OAuth token) va format. Prefiks formatdan OLDIN —
 * `sk-ant-admin01-…` ham format jihatdan to'g'ri, lekin o'z kodini oladi.
 */
export function checkAiKeyFormat(raw: unknown): AiKeyFormatResult {
  if (typeof raw !== 'string') return { ok: false, code: 'AI_KEY_FORMAT' };
  const key = raw.trim();
  if (key.startsWith('sk-ant-admin'))
    return { ok: false, code: 'AI_KEY_ADMIN_KEY' };
  if (key.startsWith('sk-ant-oat') || key.startsWith('sk-ant-ort'))
    return { ok: false, code: 'AI_KEY_OAUTH_TOKEN' };
  if (
    key.length < AI_KEY_MIN_LENGTH ||
    key.length > AI_KEY_MAX_LENGTH ||
    !AI_KEY_PATTERN.test(key)
  ) {
    return { ok: false, code: 'AI_KEY_FORMAT' };
  }
  return { ok: true, key };
}

/** Kalitning oxirgi 4 belgisi (DB `key_hint`). */
export function keyTailOf(key: string): string {
  return key.trim().slice(-4);
}

/** Ko'rinish: `sk-ant-…4f2a`. */
export function hintOf(key: string): string {
  return formatAiKeyHint(keyTailOf(key));
}

/** DB'dagi oxirgi 4 belgidan ko'rinish. */
export function formatAiKeyHint(tail: string): string {
  return `sk-ant-…${tail}`;
}

/**
 * Iz: SHA-256(UTF-8, trimmed) ning birinchi 12 kichik hex belgisi, 4 tadan
 * bo'sh joy bilan (`3f9a c21b 07de`). FE WebCrypto bilan xuddi shuni
 * hisoblaydi (504 dan keyin natijani tasdiqlash uchun).
 */
export function fingerprintOf(key: string): string {
  const hex = createHash('sha256')
    .update(key.trim(), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)}`;
}

/** «Nomi» maydonining ruxsat etilgan belgilari (Unicode harf/raqam + . , _ ( ) ' ʻ ʼ -). */
export const AI_LABEL_PATTERN = /^[\p{L}\p{N} .,_()'ʻʼ-]*$/u;
export const AI_LABEL_MAX_LENGTH = 60;
export const AI_REASON_MIN_LENGTH = 3;
export const AI_REASON_MAX_LENGTH = 300;

const KEY_PREFIX_RE = /sk-ant-/i;
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{40,}/;

/**
 * Erkin matnda kalitga o'xshash narsa bormi (`sk-ant-` har qanday registrda
 * yoki `[A-Za-z0-9_-]` dan 40+ belgilik ketma-ketlik). Bu maydonlar tarix,
 * xabar va 3 yillik zaxiralarga so'zma-so'z yoziladi.
 */
export function looksLikeAiKey(value: string): boolean {
  return KEY_PREFIX_RE.test(value) || LONG_TOKEN_RE.test(value);
}

export type AiFreeTextField = 'label' | 'reason';

/**
 * `label` / `reason` tekshiruvi. `null` — to'g'ri; aks holda maydon nomi
 * (`AI_CONFIG_INVALID {field}`). Qiymat hech qachon qaytmaydi.
 */
export function checkAiFreeText(
  field: AiFreeTextField,
  value: unknown,
): { ok: true; value: string | null } | { ok: false; field: AiFreeTextField } {
  if (value === undefined || value === null)
    return field === 'label' ? { ok: true, value: null } : { ok: false, field };
  if (typeof value !== 'string') return { ok: false, field };
  const v = value.trim();
  if (looksLikeAiKey(v)) return { ok: false, field };
  if (field === 'label') {
    if (v.length > AI_LABEL_MAX_LENGTH || !AI_LABEL_PATTERN.test(v))
      return { ok: false, field };
    return { ok: true, value: v || null };
  }
  if (v.length < AI_REASON_MIN_LENGTH || v.length > AI_REASON_MAX_LENGTH)
    return { ok: false, field };
  return { ok: true, value: v };
}

/** `sk-ant-` dan keyin 8+ belgi — log/Sentry qiymat tozalash uchun. */
export const AI_KEY_SCRUB_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
export const AI_KEY_SCRUB_REPLACEMENT = 'sk-ant-[REDACTED]';

/** Satrdagi har qanday Anthropic kalitini `sk-ant-[REDACTED]` ga almashtiradi. */
export function scrubAiKeys(text: string): string {
  return text.replace(AI_KEY_SCRUB_RE, AI_KEY_SCRUB_REPLACEMENT);
}

const SCRUB_MAX_DEPTH = 8;
const AI_KEY_TEST_RE = /sk-ant-[A-Za-z0-9_-]{8,}/;

/**
 * Har qanday qiymat ichidagi (satr, massiv, obyekt, Error) Anthropic
 * kalitlarini `sk-ant-[REDACTED]` ga almashtiradi. Kalit topilmasa AYNAN
 * o'sha qiymat (nusxa emas) qaytadi — issiq yo'lda (har log qatori) arzon.
 * Siklik havolalar va chuqurlik (8) cheklangan.
 */
export function scrubAiKeysDeep<T>(value: T): T {
  return scrubValue(value, 0, new WeakSet()) as T;
}

function scrubValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return AI_KEY_TEST_RE.test(value) ? scrubAiKeys(value) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= SCRUB_MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = scrubValue(v, depth + 1, seen);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? out : value;
  }

  if (value instanceof Error) {
    const msg = scrubValue(value.message, depth + 1, seen) as string;
    const stack =
      typeof value.stack === 'string'
        ? (scrubValue(value.stack, depth + 1, seen) as string)
        : value.stack;
    let changed = msg !== value.message || stack !== value.stack;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = scrubValue(v, depth + 1, seen);
      if (s !== v) changed = true;
      extra[k] = s;
    }
    if (!changed) return value;
    const copy = Object.create(Object.getPrototypeOf(value)) as Error;
    Object.assign(copy, extra);
    Object.defineProperty(copy, 'message', {
      value: msg,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(copy, 'stack', {
      value: stack,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    if (copy.name !== value.name) copy.name = value.name;
    return copy;
  }

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    // Buffer, Date, Map va h.k. — tegilmaydi (kalit satr sifatida yuradi).
    return value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = scrubValue(v, depth + 1, seen);
    if (s !== v) changed = true;
    out[k] = s;
  }
  return changed ? out : value;
}
