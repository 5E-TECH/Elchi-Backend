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
 * `refresh_token = null` edi). Faqat entity'ni o'zgartiradi: chaqiruvchining
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
