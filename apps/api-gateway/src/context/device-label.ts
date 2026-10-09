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
