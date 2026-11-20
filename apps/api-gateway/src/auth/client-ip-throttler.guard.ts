import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { isIPv6 } from 'node:net';

/**
 * Rate limit hisoblagichining KALITI — ishonchli mijoz IP'si (audit S3).
 *
 * ⚠️ MUAMMO. `main.ts` da `trust proxy` to'liq yoqilgan (tunnel ortida ishlash
 * uchun kerak), standart `ThrottlerGuard` esa `req.ip` ga tayanadi. To'liq
 * ishonch rejimida Express `X-Forwarded-For` zanjirining eng chap qiymatini
 * oladi — uni esa MIJOZNING O'ZI yozadi. Ya'ni har so'rovda boshqa
 * `X-Forwarded-For` yuborib, IP bo'yicha qo'yilgan chegarani (jumladan login
 * uchun daqiqasiga 10 ta urinish chegarasini) cheksiz aylanib o'tish va
 * parolni brute-force qilish mumkin edi.
 *
 * ⚠️ NEGA AYNAN `CF-Connecting-IP`. Tashqariga yagona kirish yo'li —
 * Cloudflare Tunnel (80/443 to'g'ridan-to'g'ri yopiq). Cloudflare bu
 * sarlavhani HAR DOIM o'zi qayta yozadi, mijoz yuborgan qiymat saqlanmaydi —
 * shuning uchun u `X-Forwarded-For`dan farqli o'laroq soxtalashtirib
 * bo'lmaydi.
 *
 * Sarlavha bo'lmasa (lokal ishga tushirish, ichki chaqiruv) avvalgi
 * xatti-harakat — `req.ip` — saqlanadi.
 *
 * ⚠️ KABINET WORKER PROKSISI (bir domenli API, Elchi-Frontend `worker/`,
 * docs/ops/same-origin-api.md). `admin…/api/*` → Worker → API subrequest'ida
 * `CF-Connecting-IP` ni Cloudflare quyidagicha yozadi:
 *  - Worker va API BIR zonada (elchipochta.uz) — Worker qo'ygan `x-real-ip`
 *    dan; Worker uni o'zi olgan (Cloudflare yozgan) `CF-Connecting-IP` ga
 *    tenglaydi → bu yerda haqiqiy mijoz IP'si, o'zgarish kerak emas;
 *  - BOSHQA zonada — hamma so'rovga bitta `2a06:98c0:3600::103`
 *    (`CLOUDFLARE_WORKER_EGRESS_IP`). Unda barcha foydalanuvchilar bitta
 *    hisoblagichga tushadi (login daqiqasiga 10 ta — hamma uchun). Bu holat
 *    jimgina o'tmasin — `requestContextMiddleware` ogohlantirish yozadi
 *    (`createWorkerEgressIpWarner`).
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(resolveTrustedClientIp(req) ?? 'unknown');
  }
}

/**
 * Ishonchli mijoz IP'si — `ClientIpThrottlerGuard.getTracker` ning AYNAN
 * o'zi, alohida funksiyaga chiqarilgan (f2Ud5tju): audit konteksti
 * (`context/request-context.middleware.ts`) ham shu manbadan oladi, aks holda
 * rate-limit bir IP'ni, jurnal boshqasini (Cloudflare tunnel IP'sini yoki
 * mijoz soxtalashtirgan `X-Forwarded-For` ni) ko'rardi.
 *
 * Tartib: `CF-Connecting-IP` (bo'sh emas) → `req.ip` → `req.ips[0]` → `null`.
 */
export function resolveTrustedClientIp(req: unknown): string | null {
  const typed = (req ?? {}) as {
    headers?: Record<string, string | string[] | undefined>;
    ip?: string;
    ips?: string[];
  };

  const raw = typed.headers?.['cf-connecting-ip'];
  const cfIp = Array.isArray(raw) ? raw[0] : raw;
  const trusted = String(cfIp ?? '').trim();
  if (trusted) {
    return trusted;
  }

  const fallback = typed.ip ?? typed.ips?.[0];
  return fallback === undefined || fallback === null ? null : String(fallback);
}

/**
 * Cloudflare Worker'ning BOSHQA zonaga yuborgan subrequest'larida
 * `CF-Connecting-IP` o'rniga yoziladigan umumiy manzil
 * (developers.cloudflare.com/fundamentals/reference/http-headers —
 * «CF-Connecting-IP in Worker subrequests»). Bu mijoz IP'si EMAS.
 */
export const CLOUDFLARE_WORKER_EGRESS_IP = '2a06:98c0:3600::103';

const CANONICAL_WORKER_EGRESS_HOST = `[${CLOUDFLARE_WORKER_EGRESS_IP}]`;

/** IP — Cloudflare Worker umumiy manzili (IPv6 yozilish shaklidan qat'i nazar). */
export function isCloudflareWorkerEgressIp(
  ip: string | null | undefined,
): boolean {
  const value = String(ip ?? '')
    .trim()
    .toLowerCase();
  if (!isIPv6(value)) return false;
  // URL parser IPv6'ni kanonik (qisqartirilgan) ko'rinishga keltiradi.
  return new URL(`http://[${value}]`).hostname === CANONICAL_WORKER_EGRESS_HOST;
}

/** Bir xil ogohlantirish shu oraliqda ko'pi bilan bir marta (loglar to'lib ketmasin). */
export const WORKER_EGRESS_WARN_INTERVAL_MS = 5 * 60_000;

/**
 * Mijoz IP'si o'rnida Worker umumiy manzili kelsa — ogohlantirish (oraliqda
 * bir marta, o'tkazib yuborilganlar soni bilan). Xatti-harakat o'zgarmaydi:
 * rate-limit va audit IP'si avvalgidek `resolveTrustedClientIp`; maqsad —
 * noto'g'ri sozlangan proksi (API_ORIGIN boshqa zonada) jimgina hamma
 * foydalanuvchini bitta login chegarasiga yig'masin.
 */
export function createWorkerEgressIpWarner(
  warn: (message: string) => void,
  intervalMs: number = WORKER_EGRESS_WARN_INTERVAL_MS,
  now: () => number = Date.now,
): (ip: string | null | undefined) => void {
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (ip) => {
    if (!isCloudflareWorkerEgressIp(ip)) return;
    const at = now();
    if (at - lastWarnAt < intervalMs) {
      suppressed += 1;
      return;
    }
    warn(
      `CF-Connecting-IP = Cloudflare Worker umumiy manzili (${CLOUDFLARE_WORKER_EGRESS_IP}): ` +
        "kabinet Worker'i API'ga BOSHQA Cloudflare zonasidan proksi qilmoqda — barcha foydalanuvchilar " +
        'bitta rate-limit hisoblagichida (login daqiqasiga 10 ta hamma uchun). Worker `vars.API_ORIGIN` ' +
        'kabinet bilan bir zonada bo`lsin (docs/ops/same-origin-api.md).' +
        (suppressed > 0
          ? ` Oldingi ogohlantirishdan beri yana ${suppressed} ta so'rov.`
          : ''),
    );
    lastWarnAt = at;
    suppressed = 0;
  };
}
