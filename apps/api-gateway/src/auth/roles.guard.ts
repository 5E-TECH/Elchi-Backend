import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

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

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;

    if (!user?.roles || user.roles.length === 0) {
      return false;
    }

    const normalizedUserRoles = this.normalizeRoles(user.roles);
    user.roles = normalizedUserRoles;
    const normalizedRequiredRoles = this.normalizeRoles(requiredRoles);

    return normalizedRequiredRoles.some((role) => normalizedUserRoles.includes(role));
  }
}
