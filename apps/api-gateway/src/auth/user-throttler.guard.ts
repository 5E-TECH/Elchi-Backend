import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/** Alohida throttler nomi — global 'default' (per-IP) hisoblagichiga tegmaydi. */
export const AI_USER_THROTTLER_NAME = 'ai-user';
/** `AI_PARSE_THROTTLE_LIMIT` sukuti (C11). */
export const AI_PARSE_THROTTLE_LIMIT_DEFAULT = 10;
/** `AI_PARSE_THROTTLE_TTL_MS` sukuti (C11). */
export const AI_PARSE_THROTTLE_TTL_MS_DEFAULT = 60_000;

const MIN_TTL_MS = 1000;

/**
 * `POST /orders/ai-parse` uchun FOYDALANUVCHI bo'yicha rate limit
 * (Gy8Lt6KT, NsxoDSmm; PLAN 5.8). Namuna — `PartnerThrottlerGuard`.
 *
 * ⚠️ NEGA IP EMAS. Bitta ofisdagi 5 ta operator bitta NAT IP ortida bo'lishi
 * mumkin — IP bo'yicha sanalsa bir operatorning 10 ta so'rovi qolgan
 * to'rttasini ham to'xtatib qo'yardi. Kalit — JWT `sub` (`user-<sub>`);
 * foydalanuvchi aniqlanmasa (nazariy holat — undan oldin JwtAuthGuard 401
 * qaytaradi) soxtalashtirib bo'lmaydigan `cf-connecting-ip`, u ham bo'lmasa
 * `req.ip` (ClientIpThrottlerGuard, audit S3).
 *
 * ⚠️ O'Z NOMI ('ai-user') VA O'Z LIMITI. Guard `@Throttle({ default })`
 * metama'lumotini UMUMAN o'qimaydi — `canActivate` `handleRequest` ni
 * to'g'ridan-to'g'ri chaqiradi. Route'ga `@Throttle({ default: ... })` qo'yish
 * global per-IP limitni ham 10 ga tushirib yuborardi; `@SkipThrottle()` esa
 * per-IP 60/min abuse himoyasini o'chirardi. Ikkalasi ham QO'YILMAYDI: global
 * `ClientIpThrottlerGuard` (60/IP) o'z holicha qoladi, bu guard esa ustidan
 * `sub` bo'yicha 10/60s qo'shadi (5 operator × 10 = 50 < 60).
 *
 * ⚠️ BU PUL HIMOYASI EMAS — faqat suiiste'mol (abuse) himoyasi. Hisoblagich
 * jarayon XOTIRASIDA (Redis yo'q): har deploy/restartda nollanadi va har
 * replika o'zinikini sanaydi. Anthropic xarajatini cheklaydigan yagona
 * ishonchli darvoza — ai-service'dagi global kunlik shift (AI_DAILY_USD_CAP,
 * Postgres'dagi `ai_spend_counter`).
 *
 * Limit va oyna `AI_PARSE_THROTTLE_LIMIT` / `AI_PARSE_THROTTLE_TTL_MS`
 * (sukut 10 / 60000). Limitdan oshsa `ThrottlerException` → 429.
 */
@Injectable()
export class UserThrottlerGuard extends ClientIpThrottlerGuard {
  // Xususiyat orqali (property) injeksiya: ota ThrottlerGuard konstruktori
  // (options, storage, reflector) o'zgarishsiz meros qoladi.
  @Optional()
  @Inject(ConfigService)
  private readonly config?: ConfigService;

  canActivate(context: ExecutionContext): Promise<boolean> {
    const limit = this.readInt(
      'AI_PARSE_THROTTLE_LIMIT',
      1,
      AI_PARSE_THROTTLE_LIMIT_DEFAULT,
    );
    const ttl = this.readInt(
      'AI_PARSE_THROTTLE_TTL_MS',
      MIN_TTL_MS,
      AI_PARSE_THROTTLE_TTL_MS_DEFAULT,
    );
    return this.handleRequest({
      context,
      limit,
      ttl,
      blockDuration: ttl,
      throttler: { name: AI_USER_THROTTLER_NAME, limit, ttl },
      getTracker: (req: Record<string, any>) => this.getTracker(req),
      generateKey: (ctx: ExecutionContext, tracker: string, name: string) =>
        this.generateKey(ctx, tracker, name),
    });
  }

  protected getTracker(req: Record<string, any>): Promise<string> {
    const typed = req as { user?: { sub?: unknown } | null };
    const rawSub = typed.user?.sub;
    const sub =
      typeof rawSub === 'string' || typeof rawSub === 'number'
        ? String(rawSub).trim()
        : '';
    if (sub) {
      return Promise.resolve(`user-${sub}`);
    }
    // Foydalanuvchi yo'q — ishonchli mijoz IP'si (cf-connecting-ip → req.ip).
    return super.getTracker(req);
  }

  /** Env qiymati butun son va `min` dan kichik bo'lmasa — o'sha, aks holda sukut. */
  private readInt(key: string, min: number, fallback: number): number {
    const raw = this.config?.get<unknown>(key);
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw.trim())
          : NaN;
    return Number.isInteger(value) && value >= min ? value : fallback;
  }
}
