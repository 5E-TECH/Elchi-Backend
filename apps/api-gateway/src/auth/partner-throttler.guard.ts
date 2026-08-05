import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Per-hamkor rate limit. Standart ThrottlerGuard so'rovni IP bo'yicha sanaydi;
 * bu variant esa `request.partner.id` (PartnerApiKeyGuard tomonidan qo'yiladi)
 * bo'yicha sanaydi — shunda bir hamkorning limiti boshqasiga ta'sir qilmaydi.
 * Hamkor aniqlanmagan bo'lsa (nazariy holat — undan oldin PartnerApiKeyGuard
 * 401 qaytaradi) IP'ga qaytadi. Limitdan oshsa ThrottlerGuard 429 beradi.
 */
@Injectable()
export class PartnerThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const typed = req as {
      partner?: { id?: string };
      ip?: string;
      ips?: string[];
    };
    const partnerId = typed.partner?.id;
    const tracker = partnerId
      ? `partner-${partnerId}`
      : (typed.ip ?? typed.ips?.[0] ?? 'unknown');
    return Promise.resolve(String(tracker));
  }
}
