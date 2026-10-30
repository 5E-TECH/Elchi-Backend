import {
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '@app/common';
import {
  SESSION_CHECK_UNAVAILABLE,
  SESSION_CHECK_UNAVAILABLE_MESSAGE,
  SessionRevocationService,
  sessionIdClaim,
} from './session-revocation.service';
import { TelegramTokenStateService } from './telegram-token-state.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * (Elchi Pochta #3) Yopilgan sessiya tokenini darhol rad etish. Ixtiyoriy:
   * spec'lar strategiyani usiz quradi — u holda avvalgidek faqat imzo/muddat.
   */
  private readonly revocation?: SessionRevocationService;
  /** (BOT-2 #2c) Telegram tokenlari holati. Ixtiyoriy — spec'lar usiz quradi. */
  private readonly telegramTokens?: TelegramTokenStateService;

  constructor(
    configService: ConfigService,
    @Optional() revocation?: SessionRevocationService,
    @Optional() telegramTokens?: TelegramTokenStateService,
  ) {
    const secret = configService.get<string>('ACCESS_TOKEN_KEY');
    if (!secret) {
      throw new Error('ACCESS_TOKEN_KEY is not defined');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
    this.revocation = revocation;
    this.telegramTokens = telegramTokens;
  }

  private normalizeRoles(roles?: string[]) {
    const normalized = new Set<string>();
    for (const rawRole of roles ?? []) {
      const role = String(rawRole ?? '')
        .trim()
        .toLowerCase();
      if (!role) {
        continue;
      }
      normalized.add(role);
    }
    return Array.from(normalized);
  }

  async validate(payload: {
    sub: string;
    username: string;
    name?: string | null;
    roles?: string[];
    branch_id?: string | null;
    sid?: string | null;
    auth?: string | null;
    tg_id?: string | null;
  }) {
    // (Elchi Pochta #3) `sid` li token (login/refresh) — sessiya egasi
    // tomonidan yopilgan yoki logout qilingan bo'lsa access token muddati
    // tugashini kutmay 401 (FE refresh qiladi → u ham 401 → login sahifasi).
    // `sid` siz tokenlar (Telegram Mini App, bot aktori, eski) tekshirilmaydi.
    // (NDmZMzCP) Sessiya endi TO'LIQ tekshiriladi (bloklangan / roli
    // almashgan foydalanuvchi ham 401). identity javob bermasa — sessiya
    // oxirgi 5 daqiqada «ochiq» tasdiqlangan bo'lsa o'tadi (servis `active`
    // qaytaradi, 2026-10-26); aks holda FAIL CLOSED: 503
    // `SESSION_CHECK_UNAVAILABLE` (401 emas — FE chiqarib yubormaydi,
    // foydalanuvchi qayta urinadi).
    const sessionId = sessionIdClaim(payload.sid);
    if (this.revocation && sessionId) {
      const state = await this.revocation.state(String(payload.sub), sessionId);
      if (state === 'revoked') {
        throw new UnauthorizedException('Session revoked');
      }
      if (state === 'unknown') {
        throw new ServiceUnavailableException({
          statusCode: 503,
          message: SESSION_CHECK_UNAVAILABLE_MESSAGE,
          code: SESSION_CHECK_UNAVAILABLE,
        });
      }
    }

    const roles = this.normalizeRoles(payload.roles);
    // (BOT-2 #2c) Telegram tokeni (Mini App va bot aktori) — sessiya emas,
    // lekin har so'rovda (≤60 s kesh) xodim faolligi, roli va SHU Telegram
    // ulanishi tekshiriladi: nofaol qilingan / /uzish qilgan xodim tokeni
    // 30 daqiqa ishlamaydi. identity javob bermasa — 503 (fail closed).
    if (payload.auth === 'telegram') {
      // Deploy'dan oldingi Telegram tokeni (`tg_id` / scope yo'q) — 401: bot
      // har so'rovda yangi token oladi, Mini App qayta ochiladi.
      if (typeof payload.tg_id !== 'string' || !payload.tg_id) {
        throw new UnauthorizedException('Telegram tokeni eskirgan');
      }
    }
    if (this.telegramTokens && payload.auth === 'telegram') {
      const state = await this.telegramTokens.state({
        userId: String(payload.sub ?? ''),
        telegramId: String(payload.tg_id),
        role: roles[0] ?? null,
      });
      if (state === 'revoked') {
        throw new UnauthorizedException('Telegram tokeni endi yaroqsiz');
      }
      if (state === 'unknown') {
        throw new ServiceUnavailableException({
          statusCode: 503,
          message: SESSION_CHECK_UNAVAILABLE_MESSAGE,
          code: SESSION_CHECK_UNAVAILABLE,
        });
      }
    }
    // fQi6NNUL / y8CxCtcK — so'rov aktyori kontekstga: RMQ `x-audit-actor`
    // sarlavhasi orqali har servisning `ActivityLogService.log()` i
    // `user_name`/`user_role` ni o'zi to'ldiradi. `name` claim'i eski
    // tokenlarda yo'q (ACCESS_TOKEN_TIME ichida yangilanadi) — u holda
    // faqat id/rol. (Elchi Pochta #3) `sid` (sessiya id) ham shu yo'l bilan
    // `req.user` ga o'zgarmay o'tadi; Telegram va eski tokenlarda yo'q.
    requestContext.setActor({
      userId: payload.sub == null ? undefined : String(payload.sub),
      userName: typeof payload.name === 'string' ? payload.name : undefined,
      userRole: roles[0],
    });
    return {
      ...payload,
      roles,
      branch_id: payload.branch_id ?? null,
    };
  }
}
