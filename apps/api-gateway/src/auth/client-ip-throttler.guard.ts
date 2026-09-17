import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const typed = req as {
      headers?: Record<string, string | string[] | undefined>;
      ip?: string;
      ips?: string[];
    };

    const raw = typed.headers?.['cf-connecting-ip'];
    const cfIp = Array.isArray(raw) ? raw[0] : raw;
    const trusted = String(cfIp ?? '').trim();
    if (trusted) {
      return Promise.resolve(trusted);
    }

    return Promise.resolve(String(typed.ip ?? typed.ips?.[0] ?? 'unknown'));
  }
}
