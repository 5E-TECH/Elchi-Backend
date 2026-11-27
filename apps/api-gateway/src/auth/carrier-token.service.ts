import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';

/**
 * Carrier API'ning OLCHA USLUBIDAGI kirishi (ega 2026-11-27): `POST
 * /carrier/auth/token` `username` + `password` evaziga JWT beradi, keyin
 * `Authorization: Bearer <access_token>` — xuddi Olcha API'dagidek
 * (https://api.olchamarket.uz/swagger: `/auth/token`, `expires_in=3600`).
 *
 * ⚠️ IMZO KALITI XODIM TOKENIDAN ALOHIDA. Kalit `ACCESS_TOKEN_KEY` dan
 * HMAC bilan ajratib olinadi (yangi env kerak emas), shuning uchun:
 *  - carrier tokeni xodim API'siga (`JwtStrategy`) KIRA OLMAYDI — imzo mos
 *    emas, garchi `sub` da raqam bo'lsa ham;
 *  - xodim (kurier) tokeni `/carrier/*` ga o'tmaydi.
 * `aud` ham alohida — kalit kelajakda almashsa ham tokenlar aralashmasin.
 *
 * Token ichida faqat akkaunt `id` va kalit barmoq izi (`kfp`). Har so'rovda
 * guard integration-service'dan akkauntni QAYTA o'qiydi (`validate_token`):
 * o'chirilgan akkaunt, faol emas kurier, IP ro'yxati, kalit almashtirilgani
 * tokenning 1 soati tugashini kutmay kuchga kiradi.
 */
export const CARRIER_TOKEN_TTL_SECONDS = 3600;
export const CARRIER_TOKEN_AUDIENCE = 'elchi-carrier-api';
const CARRIER_TOKEN_KEY_CONTEXT = 'elchi:carrier-api-token:v1';

export type CarrierTokenClaims = { sub: string; kfp: string };

export type CarrierTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
};

@Injectable()
export class CarrierTokenService {
  private readonly key: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    const base = config.getOrThrow<string>('ACCESS_TOKEN_KEY');
    this.key = createHmac('sha256', base)
      .update(CARRIER_TOKEN_KEY_CONTEXT)
      .digest('hex');
  }

  issue(principal: { id: string; token_fp: string }): CarrierTokenResponse {
    const access_token = this.jwt.sign(
      { kfp: principal.token_fp, typ: 'carrier' },
      {
        secret: this.key,
        algorithm: 'HS256',
        audience: CARRIER_TOKEN_AUDIENCE,
        subject: String(principal.id),
        expiresIn: CARRIER_TOKEN_TTL_SECONDS,
      },
    );
    return {
      access_token,
      token_type: 'Bearer',
      expires_in: CARRIER_TOKEN_TTL_SECONDS,
    };
  }

  /** Imzo, muddat, `aud` to'g'ri bo'lsa da'volar; aks holda `null` (401). */
  verify(token: string): CarrierTokenClaims | null {
    try {
      const payload = this.jwt.verify<{
        sub?: unknown;
        kfp?: unknown;
        typ?: unknown;
      }>(token, {
        secret: this.key,
        algorithms: ['HS256'],
        audience: CARRIER_TOKEN_AUDIENCE,
      });
      const sub = typeof payload?.sub === 'string' ? payload.sub : '';
      const kfp = typeof payload?.kfp === 'string' ? payload.kfp : '';
      if (payload?.typ !== 'carrier' || !/^\d+$/.test(sub) || !kfp) {
        return null;
      }
      return { sub, kfp };
    } catch {
      return null;
    }
  }
}
