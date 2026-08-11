import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * JWT authentication guard.
 *
 * Registered as a global APP_GUARD so authentication is DEFAULT-DENY: every HTTP
 * route requires a valid JWT unless it is explicitly marked `@Public()`. This
 * closes the previous fail-open design where a route that simply forgot
 * `@UseGuards(JwtAuthGuard)` was silently reachable unauthenticated. (Audit
 * authz P1.)
 *
 * Non-HTTP execution contexts (RMQ @EventPattern / WebSocket) are skipped here —
 * they are not client HTTP traffic and have their own transport-level handling.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
