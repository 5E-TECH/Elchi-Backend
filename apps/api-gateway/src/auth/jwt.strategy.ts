import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

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
      const role = String(rawRole ?? '').trim().toLowerCase();
      if (!role) {
        continue;
      }
      normalized.add(role);
    }
    return Array.from(normalized);
  }

  validate(payload: { sub: string; username: string; roles?: string[] }) {
    return {
      ...payload,
      roles: this.normalizeRoles(payload.roles),
    };
  }
}
