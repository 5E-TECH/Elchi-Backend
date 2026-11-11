import { ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/** Sukut: daqiqasiga 120 so'rov — BUTUN carrier akkaunti uchun (barcha endpoint). */
export const CARRIER_THROTTLE_DEFAULT_LIMIT = 120;
export const CARRIER_THROTTLE_DEFAULT_TTL_MS = 60_000;

/**
 * Env'dan musbat butun son. Bo'sh/xato qiymat — sukut (ilgari `Number('')`
 * 0 berib HAMMA so'rovni 429 qilardi, `Number('abc')` NaN esa throttler'da
 * 500 berardi). Har so'rovda o'qiladi (`@Throttle` resolvable) — modul
 * yuklanishida emas, ya'ni `.env` dagi qiymat ham hisobga olinadi.
 */
export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return fallback;
  const value = Number(raw);
  return value >= 1 ? value : fallback;
}

export const carrierThrottleLimit = (): number =>
  readPositiveIntEnv('CARRIER_THROTTLE_LIMIT', CARRIER_THROTTLE_DEFAULT_LIMIT);
export const carrierThrottleTtlMs = (): number =>
  readPositiveIntEnv(
    'CARRIER_THROTTLE_TTL_MS',
    CARRIER_THROTTLE_DEFAULT_TTL_MS,
  );

/**
 * Per-carrier rate limit (`PartnerThrottlerGuard` naqshi). So'rov
 * `request.carrier.id` bo'yicha sanaladi — bir kompaniyaning limiti
 * boshqasiga ta'sir qilmaydi. Carrier aniqlanmagan bo'lsa (undan oldin
 * `CarrierApiKeyGuard` 401 qaytaradi) soxtalashtirib bo'lmaydigan mijoz IP'si.
 *
 * ⚠️ KALIT ENDPOINTSIZ (ultracode review). Standart `generateKey`
 * `${Class}-${handler}-${name}-${tracker}` — ya'ni har endpoint o'z 120/min
 * savatiga ega edi (5 endpoint ≈ 600/min), hujjatda esa «akkaunt uchun
 * 120/min». Endi bitta carrier — bitta savat. (Global IP guard alohida —
 * u endpoint + IP bo'yicha sanaydi; hujjatda aytilgan.)
 */
@Injectable()
export class CarrierThrottlerGuard extends ClientIpThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const typed = req as { carrier?: { id?: string } };
    const carrierId = typed.carrier?.id;
    if (carrierId) {
      return Promise.resolve(`carrier-${carrierId}`);
    }
    return super.getTracker(req);
  }

  protected generateKey(
    _context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    return createHash('sha256')
      .update(`CarrierApi-${name}-${suffix}`)
      .digest('hex');
  }
}
