import {
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

interface JwtUser {
  sub: string;
  roles?: string[];
}

const BIGINT_ID_RE = /^[1-9]\d{0,18}$/;
const RPC_TIMEOUT_MS = 15_000;

export class MissingEarningsOperatorDto {
  @ApiProperty({
    example: '41',
    description:
      'Shu marketning (o`chirilmagan) operatori; begona yoki yo`q — 404',
  })
  @IsString({ message: 'operator_id majburiy' })
  @Matches(BIGINT_ID_RE, { message: "operator_id noto'g'ri" })
  operator_id!: string;
}

/**
 * 2026-11-20 — ega: «operator nomidan yaratilgan buyurtmalarga xizmat haqqi
 * yozilmayapti». Sotuv paytida operator komissiyasi belgilanmagan bo'lsa,
 * ulush yozilmaydi va keyin komissiya belgilansa ham o'tgan sotuvlar qayta
 * hisoblanmaydi. Market o'z operatori uchun:
 *  - `GET  …/missing-earnings?operator_id` — oldindan ko'rish (hech narsa
 *    yozilmaydi): nechta sotilgan buyurtmada ulush yo'q va joriy stavka
 *    bo'yicha qancha bo'ladi;
 *  - `POST …/missing-earnings` `{ operator_id }` — o'sha buyurtmalarga JORIY
 *    stavka bilan yozish (faqat daftarda qatori umuman yo'q buyurtmalar;
 *    takror bosish ikkinchi qator ochmaydi).
 * Buyurtmalar — order-service (shu market, shu operator, hozir sotilgan);
 * yozish — finance `finance.operator.earning.backfill`. FAQAT MARKET, market
 * = JWT `sub`. Elchi kassasiga ta'sir yo'q (operatorga market o'zi to'laydi).
 */
@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance/operator-payments/missing-earnings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperatorEarningBackfillGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {}

  private send<T = unknown>(
    client: ClientProxy,
    cmd: string,
    payload: object,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }

  private ownMarketId(req: { user: JwtUser }): string {
    const roles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const sub = String(req?.user?.sub ?? '').trim();
    if (!roles.includes(RoleEnum.MARKET) || !BIGINT_ID_RE.test(sub)) {
      throw new ForbiddenException(
        "Operator daromadini faqat market o'zi hisoblay oladi",
      );
    }
    return sub;
  }

  /** Shu marketning o'chirilmagan market operatori, aks holda 404 (mavjudligi oshkor qilinmaydi). */
  private async assertOwnOperator(
    marketId: string,
    operatorId: string,
  ): Promise<{ name: string }> {
    const res = await this.send<{
      data?: { role?: unknown; market_id?: unknown; name?: unknown };
    }>(this.identityClient, 'identity.user.find_by_id', {
      id: operatorId,
    }).catch(() => null);
    const user = res?.data;
    const ownMarket =
      typeof user?.market_id === 'string' || typeof user?.market_id === 'number'
        ? String(user.market_id)
        : '';
    if (
      !user ||
      user.role !== RoleEnum.MARKET_OPERATOR ||
      ownMarket !== marketId
    ) {
      throw new NotFoundException('Operator topilmadi');
    }
    return { name: typeof user.name === 'string' ? user.name.trim() : '' };
  }

  private async run(
    req: { user: JwtUser },
    operatorId: string,
    dryRun: boolean,
  ) {
    const marketId = this.ownMarketId(req);
    const operator = await this.assertOwnOperator(marketId, operatorId);
    const sold = await this.send<{
      data?: { items?: unknown; truncated?: unknown };
      items?: unknown;
      truncated?: unknown;
    }>(this.orderClient, 'order.operator.sold_orders', {
      market_id: marketId,
      operator_id: operatorId,
    });
    const items = sold?.data?.items ?? sold?.items;
    const truncated = (sold?.data?.truncated ?? sold?.truncated) === true;
    const res = await this.send<{
      statusCode?: number;
      message?: string;
      data?: Record<string, unknown>;
    }>(this.financeClient, 'finance.operator.earning.backfill', {
      operator_id: operatorId,
      orders: Array.isArray(items) ? items : [],
      dry_run: dryRun,
      requested_by: { id: marketId, role: RoleEnum.MARKET },
    });
    return {
      ...res,
      data: {
        ...(res?.data ?? {}),
        operator_name: operator.name || null,
        // 5000 dan ko'p sotuv — qolgani keyingi bosishda (yozilganlari takrorlanmaydi).
        truncated,
      },
    };
  }

  @Get()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      'Market: operatorning komissiyasiz qolgan sotuvlari — oldindan ko`rish',
    description:
      "2026-11-20. Hech narsa yozilmaydi. `{ sold_orders, already_recorded, missing, to_record, amount, commission_type, commission_value, operator_name, truncated }` — `to_record` / `amount`: joriy stavka bo'yicha yoziladigan qatorlar va summa (stavka yo'q — 0).",
  })
  @ApiOkResponse({ description: '{ statusCode, message, data }' })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  @ApiForbiddenResponse({ description: 'Market emas' })
  preview(
    @Req() req: { user: JwtUser },
    @Query() query: MissingEarningsOperatorDto,
  ) {
    return this.run(req, query.operator_id, true);
  }

  @Post()
  @HttpCode(200)
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      'Market: komissiyasiz qolgan o`tgan sotuvlarga joriy stavka bo`yicha ulush yozish',
    description:
      "2026-11-20. Faqat daftarda qatori umuman yo'q (rollback qilinmagan) hozir sotilgan buyurtmalar; mavjud qatorlar o'zgarmaydi. Takror — ikkinchi qator yo'q (`created: 0`). Javob: oldindan ko'rish maydonlari + `created`, `created_amount`. Elchi kassasiga ta'sir yo'q.",
  })
  @ApiOkResponse({ description: '{ statusCode, message, data }' })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  @ApiForbiddenResponse({ description: 'Market emas' })
  record(
    @Req() req: { user: JwtUser },
    @Body() dto: MissingEarningsOperatorDto,
  ) {
    return this.run(req, dto.operator_id, false);
  }
}
