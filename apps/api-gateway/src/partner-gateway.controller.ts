import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PartnerApiKeyGuard,
  PartnerPrincipal,
} from './auth/partner-api-key.guard';
import { PartnerThrottlerGuard } from './auth/partner-throttler.guard';

/**
 * Elchi Partner API HTTP kirish nuqtasi (`/partner/*`).
 *
 * JWT EMAS — PartnerApiKeyGuard (`X-Api-Key`) bilan himoyalanadi va
 * PartnerThrottlerGuard bilan per-hamkor rate limit qo'llanadi. Haqiqiy
 * endpointlar (geo, markets, shipments) keyingi tasklarda qo'shiladi (C1.4+, C2);
 * bu yerda C1.2 doirasida auth+limit+Swagger poydevori. Kontrakt: docs/PARTNER_API.md.
 */

// Per-hamkor rate limit (ENV bilan sozlanadi). Global IP-limitdan ustun.
export const PARTNER_THROTTLE_LIMIT = Number(
  process.env.PARTNER_THROTTLE_LIMIT ?? 120,
);
export const PARTNER_THROTTLE_TTL_MS = Number(
  process.env.PARTNER_THROTTLE_TTL_MS ?? 60_000,
);
const PARTNER_THROTTLE = {
  default: { limit: PARTNER_THROTTLE_LIMIT, ttl: PARTNER_THROTTLE_TTL_MS },
};

@ApiTags('Partner')
@ApiHeader({
  name: 'X-Api-Key',
  description: 'Hamkor API kaliti (JWT emas)',
  required: true,
})
@Throttle(PARTNER_THROTTLE)
@UseGuards(PartnerApiKeyGuard, PartnerThrottlerGuard)
@Controller('partner')
export class PartnerGatewayController {
  /**
   * Kalit tekshiruvi (auth sanity-check). Yaroqli kalitda hamkor ma'lumotini
   * qaytaradi — integratsiya klienti ulanishni shu bilan tekshiradi.
   */
  @Get('ping')
  @ApiOperation({ summary: 'Partner API kalitini tekshirish (ping)' })
  @ApiOkResponse({ description: 'Kalit yaroqli — hamkor ma‘lumoti qaytadi' })
  @ApiUnauthorizedResponse({ description: 'X-Api-Key yo‘q yoki yaroqsiz' })
  @ApiTooManyRequestsResponse({ description: 'Rate limitdan oshdi' })
  ping(@Req() request: { partner: PartnerPrincipal }) {
    return { authenticated: true, partner: request.partner };
  }
}
