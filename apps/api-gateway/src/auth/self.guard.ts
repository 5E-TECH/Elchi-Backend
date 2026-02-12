import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SELF_KEY } from './self.decorator';

interface JwtUser {
  sub: string;
  username: string;
}

@Injectable()
export class SelfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName =
      this.reflector.getAllAndOverride<string>(SELF_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'id';

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;
    const paramValue = request.params?.[paramName];

    if (!user || !paramValue) {
      return false;
    }

    return user.sub === paramValue;
  }
}
