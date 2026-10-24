import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { firstValueFrom, timeout } from 'rxjs';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
  branch_id?: string | null;
}

/** users.id — bigint. */
const MARKET_ID_RE = /^[0-9]{1,19}$/;

@ApiTags('Search')
@Controller('search')
export class SearchGatewayController {
  constructor(
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  /**
   * ISeuwhfr — MARKET_OPERATOR qidiruvi biriktirilgan marketi doirasida:
   * market identity `user.market_id` dan (so'rovdagi qiymatga ishonilmaydi).
   * Admin/superadmin va boshqa rollar uchun so'ralmaydi (`null`).
   * Biriktirilmagan / identity javob bermadi → '' — buyurtmalar chiqmaydi
   * (fail-closed), qolgan qidiruv ishlayveradi.
   */
  private async resolveOperatorMarketId(
    user: JwtUser | undefined,
  ): Promise<string | null> {
    const roles = (user?.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    if (
      !roles.includes(RoleEnum.MARKET_OPERATOR) ||
      roles.includes(RoleEnum.SUPERADMIN) ||
      roles.includes(RoleEnum.ADMIN)
    ) {
      return null;
    }
    const profile: unknown = await firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id: user?.sub })
        .pipe(timeout(8000)),
    ).catch(() => null);
    const raw = (profile as { data?: { market_id?: unknown } } | null)?.data
      ?.market_id;
    const marketId =
      typeof raw === 'string' || typeof raw === 'number'
        ? String(raw).trim()
        : '';
    return MARKET_ID_RE.test(marketId) ? marketId : '';
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Search service health check' })
  health() {
    return this.searchClient
      .send({ cmd: 'search.health' }, {})
      .pipe(timeout(8000));
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Global search',
    description:
      "Imtiyozsiz rollar: buyurtma hujjatlari faqat o'ziniki (market/kuryer/mijoz). ISeuwhfr: market operatori — biriktirilgan marketining buyurtmalari (market biriktirilmagan bo'lsa buyurtma chiqmaydi).",
  })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'source', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  async query(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const operatorMarketId = await this.resolveOperatorMarketId(req?.user);
    return firstValueFrom(
      this.searchClient
        .send<unknown>(
          { cmd: 'search.query' },
          {
            q,
            type,
            source,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
            // Scope results to the caller so the index cannot be harvested for PII.
            requester: {
              id: req?.user?.sub,
              roles: req?.user?.roles ?? [],
              // ISeuwhfr: faqat market operatori uchun (identity'dan).
              ...(operatorMarketId !== null
                ? { market_id: operatorMarketId }
                : {}),
            },
          },
        )
        .pipe(timeout(8000)),
    );
  }
}
