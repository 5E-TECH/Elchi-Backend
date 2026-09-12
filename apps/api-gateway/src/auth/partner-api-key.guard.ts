import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { isIpAllowed, normalizeIp } from './ip-allowlist.util';

/**
 * Elchi Partner API autentifikatsiyasi (JWT EMAS).
 *
 * Tashqi hamkor (marketplace) har so'rovda `X-Api-Key: <key>` header yuboradi.
 * Guard kalitni integration-service'ga RMQ orqali (`integration.partner.validate_key`)
 * tekshirtiradi — u yerda kalit SHA-256 hash bo'yicha `partners` jadvalidan
 * qidiriladi. Natija: topilmasa 401, hamkor faol emas 403, aks holda
 * `request.partner = { id, name }` to'ldiriladi va o'tadi.
 *
 * Faqat `/partner/*` route'larida ishlaydi; JWT guard bu route'larga qo'yilmaydi.
 * Kontrakt: docs/PARTNER_API.md §2.
 */
export interface PartnerPrincipal {
  id: string;
  name: string;
}

/** integration.partner.validate_key javobi (guard qaror qabul qiladi). */
interface PartnerValidation extends PartnerPrincipal {
  is_active: boolean;
  /** Ruxsat etilgan IP/CIDR ro'yxati. Bo'sh/null — cheklov yo'q. */
  ip_allowlist?: string[] | null;
}

@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      partner?: PartnerPrincipal;
      /**
       * `main.ts` da `trust proxy` yoqilgan, shuning uchun `req.ip` tunnel
       * konteyneri emas, HAQIQIY mijoz IP'sini beradi.
       */
      ip?: string;
      ips?: string[];
    }>();
    const apiKey = this.extractApiKey(request);
    if (!apiKey) {
      throw new UnauthorizedException('X-Api-Key header majburiy');
    }

    let partner: PartnerValidation | null;
    try {
      partner = await firstValueFrom(
        this.integrationClient
          .send<PartnerValidation | null>(
            { cmd: 'integration.partner.validate_key' },
            { api_key: apiKey },
          )
          .pipe(timeout(5000)),
      );
    } catch {
      // RMQ xatosi/timeout — kalitni tasdiqlab bo'lmadi, kirishga ruxsat berilmaydi.
      throw new UnauthorizedException('API kalitni tekshirib bo‘lmadi');
    }

    if (!partner) {
      throw new UnauthorizedException('API kalit yaroqsiz');
    }
    if (!partner.is_active) {
      // Kalit to'g'ri, lekin hamkor o'chirilgan — autentifikatsiya bor, ruxsat yo'q.
      throw new ForbiddenException('Hamkor faol emas');
    }

    /**
     * IP ALLOWLIST.
     *
     * ⚠️ Ilgari bu tekshiruv UMUMAN YO'Q EDI: `ip_allowlist` bazada, admin
     * API'da va UI'da bor edi, lekin hech qayerda o'qilmasdi. Operator uni
     * to'ldirib kirish cheklangan deb o'ylardi — aslida har qanday IP'dan
     * ishlardi. Yolg'on xavfsizlik hissi yo'qligidan yomonroq, chunki u
     * boshqa choralar ko'rishni to'sadi.
     *
     * Ro'yxat bo'sh bo'lsa cheklov yo'q (mavjud hamkorlar buzilmasin).
     */
    const clientIp = request.ip ?? request.ips?.[0];
    if (!isIpAllowed(clientIp, partner.ip_allowlist)) {
      throw new ForbiddenException(
        `IP ruxsat etilmagan: ${normalizeIp(clientIp) || 'aniqlanmadi'}`,
      );
    }

    request.partner = { id: partner.id, name: partner.name };
    return true;
  }

  private extractApiKey(request: {
    headers?: Record<string, unknown>;
  }): string | null {
    const raw: unknown = request.headers?.['x-api-key'];
    const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
