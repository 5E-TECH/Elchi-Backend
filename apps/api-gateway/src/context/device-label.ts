/**
 * User-Agent'dan qisqa qurilma yorlig'i (f2Ud5tju): "Telefon · Android · Chrome".
 *
 * Faqat frontend `X-Device-Name` YUBORMAGANDA ishlatiladi — jurnal chipi
 * (BeePost `DeviceIpChips` ekvivalenti) har HTTP qatorda bir xil ko'rinsin.
 * To'liq UA parser EMAS: faqat qurilma turi / OT / brauzer. Aniqlab bo'lmasa
 * (curl, server-to-server) `undefined` — sun'iy yorliq qo'yilmaydi, xom
 * `user_agent` esa baribir saqlanadi.
 */
export function describeUserAgent(
  ua: string | undefined | null,
): string | undefined {
  const s = String(ua ?? '');
  if (!s.trim()) return undefined;

  const os = /Android/i.test(s)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(s)
      ? 'iOS'
      : /Windows/i.test(s)
        ? 'Windows'
        : /CrOS/.test(s)
          ? 'ChromeOS'
          : /Macintosh|Mac OS X/i.test(s)
            ? 'macOS'
            : /Linux/i.test(s)
              ? 'Linux'
              : null;

  const isTablet =
    /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s));
  const isPhone = !isTablet && /Mobi|iPhone|iPod|Android/i.test(s);
  const type = isTablet
    ? 'Planshet'
    : isPhone
      ? 'Telefon'
      : os
        ? 'Kompyuter'
        : null;

  // Tartib muhim: Edge/Opera/Yandex/Samsung UA'sida "Chrome" ham bor,
  // Chrome UA'sida esa "Safari" bor.
  const browser = /Telegram/i.test(s)
    ? 'Telegram'
    : /YaBrowser\//.test(s)
      ? 'Yandex'
      : /Edg(A|iOS)?\//.test(s)
        ? 'Edge'
        : /OPR\/|Opera/.test(s)
          ? 'Opera'
          : /SamsungBrowser\//.test(s)
            ? 'Samsung Internet'
            : /Firefox\/|FxiOS\//.test(s)
              ? 'Firefox'
              : /Chrome\/|CriOS\//.test(s)
                ? 'Chrome'
                : /Version\/[\d.]+.*Safari\//.test(s)
                  ? 'Safari'
                  : null;

  const parts = [type, os, browser].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * `X-Device-Name` ning eng ko'p uzunligi — `user_sessions.device_name`
 * (varchar 128) va `AUDIT_CONTEXT_LIMITS.device_name` bilan bir xil.
 * Frontend boyroq nom yuboradi (Elchi Pochta #3, 2026-10-23), masalan
 * "Samsung SM-A515F · Android 13 · Chrome 155" yoki "Windows 11 · Chrome 154"
 * (~40–80 belgi) — sig'adi.
 */
export const DEVICE_NAME_MAX_LENGTH = 128;

// Boshqaruv belgilari (C0/C1, qator ajratgichlar) — bo'shliqqa almashadi.
// eslint-disable-next-line no-control-regex
const DEVICE_NAME_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Ko'rinmas belgilar — yumshoq defis, nol kenglikdagi, yo'nalish (bidi)
// boshqaruvi, BOM: «Sessiyalar» ro'yxatida nomni yashirish / teskari
// ko'rsatish (soxtalashtirish) uchun ishlatilishi mumkin — olib tashlanadi.
const DEVICE_NAME_INVISIBLE_RE =
  /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Mijoz yuborgan `X-Device-Name` (URL-decode qilingan) — ko'rinmas belgilar
 * olib tashlanadi, boshqaruv belgilari bo'shliqqa almashadi, bo'shliqlar
 * bittaga qisqaradi, DEVICE_NAME_MAX_LENGTH gacha kesiladi. Bo'sh qolsa
 * `undefined` — chaqiruvchi User-Agent'dan nom oladi (`describeUserAgent`).
 */
export function normalizeDeviceName(
  raw: string | undefined | null,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw
    .replace(DEVICE_NAME_INVISIBLE_RE, '')
    .replace(DEVICE_NAME_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX_LENGTH)
    .trim();
  return clean || undefined;
}
