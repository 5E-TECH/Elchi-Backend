import { createHash } from 'node:crypto';

/**
 * (Elchi Pochta #3) Sessiyalar xavfsizligining sof yordamchilari — DB'siz,
 * shuning uchun UserServiceService ham, spec'lar ham bemalol ishlatadi.
 */

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sid` claim'i / so'rovdagi id UUID ko'rinishidami (aks holda Postgres 22P02). */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/**
 * Qurilma ID si (`X-Device-Id`) — sessiyani qurilmaga bog'lash uchun
 * yaroqlimi (Elchi Pochta #3, "bitta qurilma — bitta sessiya"). Frontend
 * `crypto.randomUUID()` (36) yoki 32 xonali hex yuboradi. Qisqa yoki
 * g'alati qiymat ("undefined", "null", "test") QABUL QILINMAYDI: xato
 * mijoz hamma qurilmaga bir xil satr yuborsa, foydalanuvchining barcha
 * qurilmalari bitta sessiyaga qo'shilib, bir-birini chiqarib yuborardi.
 */
const REUSABLE_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{16,128}$/;

export function isReusableDeviceId(value: unknown): value is string {
  return typeof value === 'string' && REUSABLE_DEVICE_ID_RE.test(value);
}

/**
 * Refresh tokenlar SHA-256 hex ko'rinishida saqlanadi — baza sizib chiqsa
 * ham ishlaydigan sessiya tokeni oshkor bo'lmaydi. Ochiq qiymat faqat
 * tranzitda/xotirada yashaydi.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parol hashining barmoq izi. Sessiya ochilganda yoziladi va har refresh'da
 * JORIY `admins.password` bilan solishtiriladi: parol QAYSI yo'l bilan
 * almashmasin (kelajakdagi yangi oqim `invalidateAllSessions` ni unutsa
 * ham, rollback oynasidagi eski kod ham) eski sessiyalar yaroqsiz bo'ladi.
 * bcrypt hashi baribir shu bazada — barmoq izi hech narsa oshkor qilmaydi.
 */
export function passwordFingerprint(
  passwordHash: string | null | undefined,
): string {
  return createHash('sha256')
    .update(`session-pwd:${passwordHash ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Foydalanuvchining BARCHA sessiyalarini yopadi — parol/telefon/rol
 * almashishi, bloklash, o'chirish (ilgari shu joylarda faqat
 * `refresh_token = null` edi). ISTISNO (2026-10-23): foydalanuvchi parolni
 * O'ZI (`sid` li sessiyadan) almashtirsa epoch oshmaydi — joriy sessiya
 * qoladi, qolganlari `password_changed` bilan aniq yopiladi
 * (`AuthSessionService.afterPasswordChange`). Faqat entity'ni o'zgartiradi: chaqiruvchining
 * `users.save()` i `session_epoch` ni AYNI UPDATE'da yozadi (atomar —
 * alohida so'rov yiqilib, sessiyalar ochiq qolishi mumkin emas). Eski ustun
 * ham tozalanadi: deploy'dan oldingi (legacy) token ham o'ladi.
 */
export function invalidateAllSessions(user: {
  refresh_token: string | null;
  session_epoch: number;
}): void {
  user.refresh_token = null;
  user.session_epoch = (Number(user.session_epoch) || 0) + 1;
}

/**
 * (Elchi Pochta #3, 2026-10-23) "Telegram'dagidek" yangi sessiya qulfi:
 * sessiya yaratilganiga (`created_at` — shu qurilmadan BIRINCHI login;
 * qayta kirgan qurilmada o'zgarmaydi) shuncha soat to'lmaguncha u BOSHQA
 * sessiyalarni (eskisini ham, yangisini ham) yopa olmaydi. Parol
 * o'g'irlangan bo'lsa, yangi qurilma egasini chiqarib yubora olmasin; egasi
 * esa eski qurilmasidan yangisini yopa oladi. `SESSION_REVOKE_LOCK_HOURS`
 * (sukut 48; `0` — qulf o'chiq). O'z sessiyasidan chiqish (logout) va parol
 * almashtirish qulfga BOG'LIQ EMAS.
 */
export const SESSION_REVOKE_LOCK_HOURS_DEFAULT = 48;

const HOUR_MS = 60 * 60 * 1000;

/**
 * `SESSION_REVOKE_LOCK_HOURS` → ms. Bo'sh / berilmagan / noto'g'ri qiymat —
 * sukut (48 soat); `0` — qulf o'chiq; kasr soat ham mumkin (`0.5` — 30 daqiqa).
 */
export function resolveSessionRevokeLockMs(raw: unknown): number {
  const fallback = SESSION_REVOKE_LOCK_HOURS_DEFAULT * HOUR_MS;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const hours = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(hours) && hours >= 0
    ? Math.round(hours * HOUR_MS)
    : fallback;
}

export interface SessionRevokeLock {
  /** Hozir boshqa sessiyalarni yopish mumkinmi. */
  allowed: boolean;
  /** Qachondan mumkin (`created_at` + qulf); hozir mumkin bo'lsa `null`. */
  available_at: Date | null;
}

/**
 * Chaqiruvchi sessiyasi (`createdAt` — uning `created_at` i) boshqa
 * sessiyalarni yopa oladimi. Chegara: `now >= created_at + qulf` — aniq
 * 48:00 da mumkin, 47:59 da hali yo'q. `lockMs <= 0` — doim mumkin.
 * `created_at` o'qilmasa (bo'lmasligi kerak — ustun NOT NULL) — yopiq
 * (xavfsiz tomonga): `available_at = now + qulf`.
 */
export function sessionRevokeLock(
  createdAt: Date | string | null | undefined,
  lockMs: number,
  now: Date = new Date(),
): SessionRevokeLock {
  if (!(lockMs > 0)) return { allowed: true, available_at: null };
  const created =
    createdAt === null || createdAt === undefined
      ? Number.NaN
      : new Date(createdAt).getTime();
  const availableAt = Number.isFinite(created)
    ? created + lockMs
    : now.getTime() + lockMs;
  return now.getTime() >= availableAt
    ? { allowed: true, available_at: null }
    : { allowed: false, available_at: new Date(availableAt) };
}

/** Toshkent (UTC+5, yozgi vaqt yo'q) uchun siljish. */
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

/**
 * `DD.MM.YYYY HH:MM` Toshkent vaqtida (ICU'ga bog'liq emas). Daqiqa YUQORIGA
 * yaxlitlanadi: «12:00:30 da mumkin» → «12:01 dan keyin» (ko'rsatilgan
 * vaqtda urinish hech qachon 403 olmaydi).
 */
export function formatTashkentMinuteCeil(date: Date): string {
  const ms = Math.ceil(date.getTime() / MINUTE_MS) * MINUTE_MS;
  const local = new Date(ms + TASHKENT_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.` +
    `${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}
