import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ExtractJwt } from 'passport-jwt';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

const bearerFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();

/**
 * Global 'default' rate limit (APP_GUARD; `THROTTLE_LIMIT`, sukut 60/daqiqa,
 * har route o'z hisoblagichi bilan) — KALIT so'rov turiga qarab:
 *
 *  - kirgan foydalanuvchi (imzosi to'g'ri access token, route `@Public()`
 *    EMAS) → `user-<sub>`;
 *  - qolgan hammasi (tokensiz/yaroqsiz token, login, refresh, OTP, public va
 *    webhook route'lari) → avvalgidek ishonchli IP (`CF-Connecting-IP`,
 *    `ClientIpThrottlerGuard`).
 *
 * ⚠️ NEGA. Bitta ofis (NAT) yoki mobil operator CGNAT'i ortidagi BARCHA
 * operatorlar bitta tashqi IP'dan chiqadi — IP bo'yicha sanalganda ular bitta
 * 60/daqiqa limitni bo'lishardi va oddiy ish (ro'yxatni yangilash, buyurtma
 * qabul qilish) 429 ga urilardi. Batafsil: `user-throttler.guard.ts` izohi.
 *
 * ⚠️ NEGA TOKEN SHU YERDA TEKSHIRILADI. Bu guard `JwtAuthGuard` dan OLDIN
 * ishlaydi (api-gateway.module APP_GUARD tartibi) — `req.user` hali yo'q.
 * Tartibni almashtirish yaroqsiz tokenli so'rovlarni limitdan chiqarardi,
 * strategiya esa sessiya holatini identity'dan so'raydi (RPC). Shuning uchun
 * faqat IMZO va muddat (HS256, `ACCESS_TOKEN_KEY` — JwtStrategy bilan AYNI)
 * tekshiriladi: imzosiz `sub` ni soxtalashtirib, har so'rovda yangi
 * hisoblagich olib bo'lmaydi. Sessiya bekor qilinganmi — keyin JwtAuthGuard
 * hal qiladi (401); bunday so'rov ham shu `sub` limitida sanaladi.
 *
 * Refresh token boshqa kalit bilan imzolangan — bu yerda yaroqsiz, IP'ga
 * tushadi.
 */
@Injectable()
export class GlobalThrottlerGuard extends ClientIpThrottlerGuard {
  // Xususiyat orqali (property) injeksiya: ota ThrottlerGuard konstruktori
  // (options, storage, reflector) o'zgarishsiz meros qoladi.
  @Optional()
  @Inject(JwtService)
  private readonly jwt?: JwtService;

  protected getTracker(
    req: Record<string, any>,
    context?: ExecutionContext,
  ): Promise<string> {
    const sub = this.authenticatedSub(req, context);
    if (sub) {
      return Promise.resolve(`user-${sub}`);
    }
    return super.getTracker(req);
  }

  private authenticatedSub(
    req: Record<string, any>,
    context: ExecutionContext | undefined,
  ): string | null {
    if (!this.jwt || !context || context.getType() !== 'http') {
      return null;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return null;
    }
    const token = bearerFromRequest(req as never);
    if (!token) {
      return null;
    }
    try {
      const payload = this.jwt.verify<{ sub?: unknown }>(token);
      const raw = payload?.sub;
      const sub =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw).trim()
          : '';
      return sub || null;
    } catch {
      return null;
    }
  }
}
