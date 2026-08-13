import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or controller) as reachable WITHOUT a JWT.
 *
 * Authentication is default-deny: JwtAuthGuard is registered as a global
 * APP_GUARD, so every HTTP route requires a valid JWT unless it opts out with
 * `@Public()`. Use it only for genuinely public endpoints (health, login,
 * refresh, HMAC webhooks, public file view) and for routes protected by a
 * DIFFERENT guard (e.g. the Partner API's PartnerApiKeyGuard). (Audit authz P1.)
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
