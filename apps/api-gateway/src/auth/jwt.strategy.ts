import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '@app/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const secret = configService.get<string>('ACCESS_TOKEN_KEY');
    if (!secret) {
      throw new Error('ACCESS_TOKEN_KEY is not defined');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
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

  validate(payload: {
    sub: string;
    username: string;
    name?: string | null;
    roles?: string[];
    branch_id?: string | null;
  }) {
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
