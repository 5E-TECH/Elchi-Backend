import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { CARRIER_ERROR_CODES } from '@app/common';
import { isIpAllowed, normalizeIp } from './ip-allowlist.util';

/**
 * Carrier API autentifikatsiyasi (JWT EMAS) — tashqi yetkazuvchi kompaniya.
 *
 * Kompaniya har so'rovda `X-Api-Key: elc_…` yuboradi. Kalit integration-service'da
 * (`integration.carrier.validate_key`) SHA-256 hash bo'yicha `carrier_accounts`
 * jadvalidan qidiriladi. Topilmasa 401, akkaunt yoki bog'langan kurier faol
 * emas 403, IP ro'yxatda yo'q 403, tekshirib bo'lmadi (RMQ/identity uzilishi)
 * 503; aks holda `request.carrier` to'ldiriladi.
 *
 * `PartnerApiKeyGuard` bilan bir xil naqsh, lekin ATAYLAB alohida jadval va
 * alohida RMQ buyrug'i: partner kaliti `/carrier/*` ga, carrier kaliti esa
 * `/partner/*` ga (buyurtma yaratishga) kira olmaydi.
 *
 * Faqat `/carrier/*` route'larida ishlaydi. Kontrakt: docs/public/CARRIER_API.md.
 */
export interface CarrierPrincipal {
  /** `carrier_accounts.id` */
  id: string;
  name: string;
  /** Bog'langan kurier user id — barcha amallar shu kurier nomidan bajariladi. */
  courier_user_id: string;
  /**
   * `status: rollback` ruxsati (admin toggle'i, sukut `false`). YASHIRIN —
   * javoblarga chiqmaydi; o'chiq bo'lsa `rollback` noma'lum status kabi 400
   * (`carrier-status-body.ts`). Kesh yo'q: har so'rovda integration-service
   * bazadan o'qiydi — toggle keyingi so'rovdan kuchga kiradi.
   */
  rollback_enabled: boolean;
}

interface CarrierValidation extends Omit<CarrierPrincipal, 'rollback_enabled'> {
  is_active: boolean;
  /** Eski integration-service javobida yo'q — yopiq (`false`). */
  rollback_enabled?: boolean;
  ip_allowlist?: string[] | null;
  /** Bog'langan kurier hozir faolmi (integration-service tekshiradi, 30 s kesh). */
  courier_active?: boolean;
}

@Injectable()
export class CarrierApiKeyGuard implements CanActivate {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      carrier?: CarrierPrincipal;
      ip?: string;
      ips?: string[];
    }>();
    const apiKey = this.extractApiKey(request);
    if (!apiKey) {
      throw new UnauthorizedException('X-Api-Key header majburiy');
    }

    let carrier: CarrierValidation | null;
    try {
      carrier = await firstValueFrom(
        this.integrationClient
          .send<CarrierValidation | null>(
            { cmd: 'integration.carrier.validate_key' },
            { api_key: apiKey },
          )
          .pipe(timeout(5000)),
      );
    } catch {
      /**
       * RMQ xatosi/timeout yoki identity uzilishi — kalitni TASDIQLAB BO'LMADI.
       * Kirish yo'q (yopiq), lekin 401 EMAS: hujjatda 401 «kalit yaroqsiz,
       * qayta urinmang» degani — vaqtinchalik uzilishda kompaniya statuslarni
       * yo'qotib qo'yardi. 503 — «ayni Idempotency-Key bilan qayta urining»
       * (JWT yo'lidagi SESSION_CHECK_UNAVAILABLE bilan bir xil yondashuv).
       */
      throw new ServiceUnavailableException({
        statusCode: 503,
        message:
          "API kalitni tekshirib bo'lmadi — birozdan keyin qayta urining",
        code: CARRIER_ERROR_CODES.KEY_CHECK_UNAVAILABLE,
      });
    }

    if (!carrier) {
      throw new UnauthorizedException('API kalit yaroqsiz');
    }
    if (!carrier.is_active) {
      throw new ForbiddenException('Carrier akkaunt faol emas');
    }
    /**
     * IP allowlist — `PartnerApiKeyGuard` dagi kabi `CF-Connecting-IP` ga
     * tayanadi (fix3 RBAC-12): `req.ip` ni mijoz `X-Forwarded-For` bilan
     * soxtalashtira oladi. Kurier holatidan OLDIN: ruxsatsiz IP'dan sizib
     * chiqqan kalit bilan kurier faol-faol emasligini bilib bo'lmasin.
     */
    const clientIp = this.resolveClientIp(request);
    if (!isIpAllowed(clientIp, carrier.ip_allowlist)) {
      throw new ForbiddenException(
        `IP ruxsat etilmagan: ${normalizeIp(clientIp) || 'aniqlanmadi'}`,
      );
    }
    /**
     * Bog'langan kurier bloklangan / o'chirilgan / kurier emas — kalit ham
     * ishlamaydi (JWT kurier sessiyalari ham shunda bekor bo'ladi).
     * `courier_active` yo'q (eski integration-service javobi) — yopiq.
     */
    if (carrier.courier_active !== true) {
      throw new ForbiddenException({
        statusCode: 403,
        message:
          'Bog‘langan kurier faol emas — Elchi operatoriga murojaat qiling',
        code: CARRIER_ERROR_CODES.COURIER_INACTIVE,
      });
    }
    /**
     * Kurier bog'lanmagan akkaunt — nazariy holat (ustun NOT NULL), lekin
     * shunday javob kelsa downstream requester `id` siz qolib, amal "kim
     * nomidan" ekani yo'qolardi. Yopiq rad etamiz.
     */
    if (!/^\d+$/.test(String(carrier.courier_user_id ?? ''))) {
      throw new ForbiddenException('Carrier akkauntga kurier bog‘lanmagan');
    }

    request.carrier = {
      id: String(carrier.id),
      name: carrier.name,
      courier_user_id: String(carrier.courier_user_id),
      // Faqat aniq `true` (rolling deploy: eski javobda maydon yo'q — o'chiq).
      rollback_enabled: carrier.rollback_enabled === true,
    };
    return true;
  }

  private resolveClientIp(request: {
    headers?: Record<string, unknown>;
    ip?: string;
    ips?: string[];
  }): string | undefined {
    const raw: unknown = request.headers?.['cf-connecting-ip'];
    const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    const trusted = typeof value === 'string' ? value.trim() : '';
    if (trusted) {
      return trusted;
    }
    return request.ip ?? request.ips?.[0];
  }

  private extractApiKey(request: {
    headers?: Record<string, unknown>;
  }): string | null {
    const raw: unknown = request.headers?.['x-api-key'];
    const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
