import { Injectable } from '@nestjs/common';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/**
 * Per-hamkor rate limit. Standart ThrottlerGuard so'rovni IP bo'yicha sanaydi;
 * bu variant esa `request.partner.id` (PartnerApiKeyGuard tomonidan qo'yiladi)
 * bo'yicha sanaydi — shunda bir hamkorning limiti boshqasiga ta'sir qilmaydi.
 * Hamkor aniqlanmagan bo'lsa (nazariy holat — undan oldin PartnerApiKeyGuard
 * 401 qaytaradi) IP'ga qaytadi. Limitdan oshsa ThrottlerGuard 429 beradi.
 */
@Injectable()
export class PartnerThrottlerGuard extends ClientIpThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const typed = req as { partner?: { id?: string } };
    const partnerId = typed.partner?.id;
    if (partnerId) {
      return Promise.resolve(`partner-${partnerId}`);
    }
    // Hamkor aniqlanmagan bo'lsa — soxtalashtirib bo'lmaydigan mijoz IP'si
    // (audit S3), oddiy `req.ip` emas.
    return super.getTracker(req);
  }
}
