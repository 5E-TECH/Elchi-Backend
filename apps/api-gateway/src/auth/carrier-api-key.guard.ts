import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { CARRIER_ERROR_CODES } from '@app/common';
import { isIpAllowed, normalizeIp } from './ip-allowlist.util';
import { CarrierTokenService } from './carrier-token.service';

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
 * OLCHA USLUBIDAGI KIRISH (ega 2026-11-27): `X-Api-Key` o'rniga
 * `Authorization: Bearer <access_token>` ham qabul qilinadi — token
 * `POST /carrier/auth/token` dan (`CarrierTokenService`). Ikkalasi kelsa
 * `X-Api-Key` ustun (eski chaqiruvchilar xulqi o'zgarmaydi). Token egasi har
 * so'rovda `integration.carrier.validate_token` bilan qayta o'qiladi, so'ng
 * kalitdagi bilan AYNI tekshiruvlar (faol, IP, kurier) — `admit`.
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

export interface CarrierValidation extends Omit<
  CarrierPrincipal,
  'rollback_enabled'
> {
  is_active: boolean;
  /** Eski integration-service javobida yo'q — yopiq (`false`). */
  rollback_enabled?: boolean;
  ip_allowlist?: string[] | null;
  /** Bog'langan kurier hozir faolmi (integration-service tekshiradi, 30 s kesh). */
  courier_active?: boolean;
  /**
   * Joriy kalit barmoq izi — faqat token berishda (`/carrier/auth/token`)
   * ishlatiladi; `request.carrier` ga TUSHMAYDI. Eski integration-service
   * javobida yo'q — u holda token berilmaydi (503).
   */
  token_fp?: string;
}

type GuardRequest = {
  headers: Record<string, unknown>;
  carrier?: CarrierPrincipal;
  ip?: string;
  ips?: string[];
};

@Injectable()
export class CarrierApiKeyGuard implements CanActivate {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
    @Optional() private readonly tokens?: CarrierTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const apiKey = this.extractApiKey(request);
    let carrier: CarrierValidation | null;
    if (apiKey) {
      carrier = await this.resolveByKey(apiKey);
      if (!carrier) {
        throw new UnauthorizedException('API kalit yaroqsiz');
      }
    } else {
      const bearer = this.extractBearer(request);
      if (!bearer) {
        throw new UnauthorizedException(
          'X-Api-Key header majburiy (yoki Authorization: Bearer <access_token> — POST /carrier/auth/token)',
        );
      }
      const claims = this.tokens?.verify(bearer) ?? null;
      if (!claims) {
        throw new UnauthorizedException(
          'Token yaroqsiz yoki muddati tugagan — POST /carrier/auth/token orqali yangisini oling',
        );
      }
      carrier = await this.resolve('integration.carrier.validate_token', {
        id: claims.sub,
        token_fp: claims.kfp,
      });
      if (!carrier) {
        throw new UnauthorizedException(
          'Token bekor qilingan (kalit almashtirilgan yoki akkaunt o‘chirilgan) — POST /carrier/auth/token orqali yangisini oling',
        );
      }
    }
    request.carrier = this.admit(request, carrier);
    return true;
  }

  /** `X-Api-Key` (yoki `/carrier/auth/token` dagi `password`) egasi; topilmasa `null`. */
  resolveByKey(apiKey: string): Promise<CarrierValidation | null> {
    return this.resolve('integration.carrier.validate_key', {
      api_key: apiKey,
    });
  }

  private async resolve(
    cmd: string,
    payload: object,
  ): Promise<CarrierValidation | null> {
    try {
      return await firstValueFrom(
        this.integrationClient
          .send<CarrierValidation | null>({ cmd }, payload)
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
  }

  /**
   * Topilgan akkauntni so'rovga QO'YISH-QO'YMASLIK (kalit ham, token ham,
   * `/carrier/auth/token` ham shu yerdan o'tadi): faol emas 403, IP 403,
   * kurier faol emas 403, kurier bog'lanmagan 403.
   */
  admit(request: GuardRequest, carrier: CarrierValidation): CarrierPrincipal {
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

    return {
      id: String(carrier.id),
      name: carrier.name,
      courier_user_id: String(carrier.courier_user_id),
      // Faqat aniq `true` (rolling deploy: eski javobda maydon yo'q — o'chiq).
      rollback_enabled: carrier.rollback_enabled === true,
    };
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

  /** `Authorization: Bearer <token>` (sxema registrsiz); bo'lmasa `null`. */
  private extractBearer(request: {
    headers?: Record<string, unknown>;
  }): string | null {
    const raw: unknown = request.headers?.authorization;
    const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    if (typeof value !== 'string') return null;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(value.trim());
    return match ? match[1] : null;
  }
}
