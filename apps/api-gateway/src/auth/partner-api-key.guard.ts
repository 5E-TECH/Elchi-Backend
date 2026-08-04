import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * Elchi Partner API autentifikatsiyasi (JWT EMAS).
 *
 * Tashqi hamkor (marketplace) har so'rovda `X-Api-Key: <key>` header yuboradi.
 * Guard kalitni integration-service'ga RMQ orqali (`integration.partner.validate_key`)
 * tekshirtiradi — u yerda kalit SHA-256 hash bo'yicha `partners` jadvalidan
 * qidiriladi. Topilsa `request.partner = { id, name }` to'ldiriladi, aks holda 401.
 *
 * Faqat `/partner/*` route'larida ishlaydi; JWT guard bu route'larga qo'yilmaydi.
 * Kontrakt: docs/PARTNER_API.md §2.
 */
export interface PartnerPrincipal {
  id: string;
  name: string;
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
    }>();
    const apiKey = this.extractApiKey(request);
    if (!apiKey) {
      throw new UnauthorizedException('X-Api-Key header majburiy');
    }

    let partner: PartnerPrincipal | null;
    try {
      partner = await firstValueFrom(
        this.integrationClient
          .send<PartnerPrincipal | null>(
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

    request.partner = partner;
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
