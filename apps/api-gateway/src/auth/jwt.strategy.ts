import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '@app/common';
import { SessionRevocationService } from './session-revocation.service';

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * (Elchi Pochta #3) Yopilgan sessiya tokenini darhol rad etish. Ixtiyoriy:
   * spec'lar strategiyani usiz quradi — u holda avvalgidek faqat imzo/muddat.
   */
  private readonly revocation?: SessionRevocationService;

  constructor(
    configService: ConfigService,
    @Optional() revocation?: SessionRevocationService,
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
  }) {
    // (Elchi Pochta #3) `sid` li token (login/refresh) — sessiya egasi
    // tomonidan yopilgan yoki logout qilingan bo'lsa access token muddati
    // tugashini kutmay 401 (FE refresh qiladi → u ham 401 → login sahifasi).
    // `sid` siz tokenlar (Telegram Mini App, bot aktori, eski) tekshirilmaydi.
    // identity javob bermasa — ruxsat (fail open, SessionRevocationService).
    if (
      this.revocation &&
      typeof payload.sid === 'string' &&
      SESSION_ID_RE.test(payload.sid) &&
      (await this.revocation.isRevoked(String(payload.sub), payload.sid))
    ) {
      throw new UnauthorizedException('Session revoked');
    }

    const roles = this.normalizeRoles(payload.roles);
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
