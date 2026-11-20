/**
 * (NDmZMzCP, 2026-10-26) Refresh token cookie (`refresh_token`, `path=/auth`)
 * parametrlari — o'rnatish va o'chirish AYNI qiymatlar bilan (aks holda
 * brauzer `clearCookie` ni boshqa cookie deb biladi).
 *
 * `SameSite`: ilgari prod'da `None` edi (har qanday saytdan so'rovga cookie
 * qo'shilardi — CSRF yuzasi). Endi sukut `Lax`:
 *  - kabinet `https://admin.elchipochta.uz`, API `https://api.elchipochta.uz` —
 *    bitta sayt (`elchipochta.uz`), shuning uchun `POST /auth/refresh`
 *    (`withCredentials`) cookie'ni `Lax` da ham oladi;
 *  - Telegram Mini App (`/tg/scan`) cookie ishlatmaydi: `POST /auth/telegram`
 *    faqat 30 daqiqalik access token beradi (refresh yo'q, FE
 *    `withCredentials: false`) — o'zgarish unga ta'sir qilmaydi.
 *
 * `REFRESH_COOKIE_SAMESITE` = `lax` | `strict` | `none` (boshqa / bo'sh —
 * `lax`). `none` faqat favqulodda orqaga qaytish uchun; u holda `Secure`
 * majburiy (brauzerlar `SameSite=None` ni `Secure` siz rad etadi).
 *
 * `Path` — ATAYLAB `/auth` (bir domenli API'da ham). Kabinet API'ni o'z
 * domeni orqali chaqirganda (`test-admin…/api/*` → Elchi-Frontend Worker
 * proksisi, docs/ops/same-origin-api.md) Worker `/api` prefiksini olib
 * tashlaydi va javobdagi `Set-Cookie` `Path` iga uni qaytarib qo'shadi
 * (`/auth` → `/api/auth`, nginx `proxy_cookie_path` kabi). Shu sabab bu yerda
 * `/api/auth` YOZILMAYDI (aks holda `/api/api/auth`) — backend ikkala yo'lni
 * (to'g'ridan-to'g'ri API va proksi) bir vaqtda o'zgarishsiz xizmat qiladi.
 * Cookie host-only (`Domain` yo'q) — proksida kabinet hostiga bog'lanadi.
 */
export type RefreshCookieSameSite = 'lax' | 'strict' | 'none';

export const REFRESH_COOKIE_PATH = '/auth';

const SAME_SITE_VALUES: readonly RefreshCookieSameSite[] = [
  'lax',
  'strict',
  'none',
];

export interface RefreshCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: RefreshCookieSameSite;
  path: typeof REFRESH_COOKIE_PATH;
}

export function resolveRefreshCookieSameSite(
  raw: string | undefined,
): RefreshCookieSameSite {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase() as RefreshCookieSameSite;
  return SAME_SITE_VALUES.includes(value) ? value : 'lax';
}

export function refreshCookieOptions(
  env: NodeJS.ProcessEnv = process.env,
): RefreshCookieOptions {
  const sameSite = resolveRefreshCookieSameSite(env.REFRESH_COOKIE_SAMESITE);
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production' || sameSite === 'none',
    sameSite,
    path: REFRESH_COOKIE_PATH,
  };
}
