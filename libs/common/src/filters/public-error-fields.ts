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
