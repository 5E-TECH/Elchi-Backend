import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CancelOperatorPaymentRequestDto,
  ListOperatorPaymentsQueryDto,
  OperatorBalancesDto,
  OperatorPaymentListDto,
  OperatorPaymentViewDto,
  RecordOperatorPaymentRequestDto,
} from './dto/operator-payment.swagger.dto';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';

interface JwtUser {
  sub: string;
  roles?: string[];
}

interface MarketOperatorRef {
  id: string;
  name: string;
  status: string;
}

const RPC_TIMEOUT_MS = 8000;
const BIGINT_ID_RE = /^[1-9]\d{0,18}$/;
/** identity `find_by_market` sahifasi ≤ 100; 10 sahifa — 1000 operator. */
const OPERATOR_PAGE_LIMIT = 100;
const OPERATOR_MAX_PAGES = 10;

/**
 * F2qp6FtE (ega qarori 2026-11-16) — market o'z operatoriga O'ZI, istagan
 * vaqtida to'laydi. Bu Elchi kassasiga (Asosiy kassa) TA'SIR QILMAYDI — kassa
 * faqat market bilan Elchi o'rtasidagi oldi-berdi. Tizim faqat ma'lumot
 * saqlaydi: operator qancha ishlab topgani va qanchasi to'lab berilgani.
 *
 * KO'LAM — hammasi FAQAT MARKET: market id — JWT `sub` (tana yoki so'rovdagi
 * `market_id` qabul qilinmaydi). Operator — shu marketning o'chirilmagan
 * operatori (identity `market_operator.find_by_market`); begona yoki yo'q —
 * 404 (mavjudligi oshkor qilinmaydi). Superadmin/admin endi yozmaydi; o'qish —
 * `GET /finance/operators/:operator_id/{balance,payments}`. Operator o'zi —
 * `GET /finance/operators/me/*`.
 */
@ApiTags('Finance')
@ApiExtraModels(
  OperatorPaymentViewDto,
  OperatorPaymentListDto,
  OperatorBalancesDto,
)
@ApiBearerAuth()
@Controller('finance/operator-payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperatorPaymentGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
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

  private rolesOf(req: { user: JwtUser }): string[] {
    return (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  /** Market so'rovchisining o'z id'si (JWT sub) — ko'lamning yagona manbai. */
  private ownMarketId(req: { user: JwtUser }): string {
    const sub = String(req?.user?.sub ?? '').trim();
    if (
      !this.rolesOf(req).includes(RoleEnum.MARKET) ||
      !BIGINT_ID_RE.test(sub)
    ) {
      throw new ForbiddenException(
        "Operatorga to'lovni faqat market o'zi yoza oladi",
      );
    }
    return sub;
  }

  /** Marketning barcha o'chirilmagan operatorlari (faol va nofaol). */
  private async marketOperators(
    req: { user: JwtUser },
    marketId: string,
  ): Promise<MarketOperatorRef[]> {
    const operators: MarketOperatorRef[] = [];
    for (let page = 1; page <= OPERATOR_MAX_PAGES; page += 1) {
      const res = await this.send<{
        data?: {
          items?: Array<{ id?: unknown; name?: unknown; status?: unknown }>;
          meta?: { totalPages?: unknown };
        };
      }>(this.identityClient, 'identity.market_operator.find_by_market', {
        market_id: marketId,
        query: { page, limit: OPERATOR_PAGE_LIMIT },
        requester: { id: marketId, roles: this.rolesOf(req) },
      });
      const items = Array.isArray(res?.data?.items) ? res.data.items : [];
      for (const item of items) {
        const id =
          typeof item?.id === 'string' || typeof item?.id === 'number'
            ? String(item.id)
            : '';
        if (!BIGINT_ID_RE.test(id)) continue;
        operators.push({
          id,
          name: typeof item.name === 'string' ? item.name.trim() : '',
          status: typeof item.status === 'string' ? item.status : 'active',
        });
      }
      const totalPages = Number(res?.data?.meta?.totalPages ?? 1);
      if (items.length === 0 || !(page < totalPages)) break;
    }
    return operators;
  }

  @Get('balances')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market: har operator — «Ishlab topdi / To'landi / Qoldiq»",
    description:
      "F2qp6FtE. Marketning barcha o'chirilmagan operatorlari (faol va nofaol), ism tartibida emas — identity ro'yxati tartibida. `earned` — o'chirilmagan daromadlar (`GET operators/me/balance` bilan AYNI qoida), `paid` — o'chirilmagan va bekor qilinmagan to'lovlar (eski Elchi to'lovlari ham), `balance` = earned − paid (manfiy — ortiqcha to'langan). `totals` — yig'indi.",
  })
  @ApiOkResponse({
    description: '{ statusCode, message, data: OperatorBalancesDto }',
    type: OperatorBalancesDto,
  })
  @ApiForbiddenResponse({ description: 'Market emas' })
  async balances(@Req() req: { user: JwtUser }) {
    const marketId = this.ownMarketId(req);
    const operators = await this.marketOperators(req, marketId);
    const res = await this.send<{
      statusCode?: number;
      message?: string;
      data?: {
        items?: Array<Record<string, unknown> & { operator_id?: string }>;
        totals?: unknown;
      };
    }>(this.financeClient, 'finance.operator.market_balances', {
      operator_ids: operators.map((operator) => operator.id),
    });
    const byId = new Map(operators.map((operator) => [operator.id, operator]));
    return {
      ...res,
      data: {
        ...res?.data,
        items: (res?.data?.items ?? []).map((item) => {
          const operator = byId.get(String(item.operator_id));
          return {
            ...item,
            operator_name: operator?.name ?? '',
            status: operator?.status ?? 'active',
          };
        }),
      },
    };
  }

  @Get()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market: operatorlarga to'lovlar tarixi",
    description:
      "F2qp6FtE. Yangisi tepada (to'lov sanasi, keyin id). Shu market yozganlari + uning operatorlariga Elchi eski yo'lda (Asosiy kassadan, `source: elchi`) yozganlari. Bekor qilinganlar ham chiqadi (`status: cancelled`, sabab bilan). `operator_id` — faqat o'z operatori (begona — 404).",
  })
  @ApiOkResponse({
    description: '{ statusCode, message, data: OperatorPaymentListDto }',
    type: OperatorPaymentListDto,
  })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  async list(
    @Req() req: { user: JwtUser },
    @Query() query: ListOperatorPaymentsQueryDto,
  ) {
    const marketId = this.ownMarketId(req);
    const operators = await this.marketOperators(req, marketId);
    const byId = new Map(operators.map((operator) => [operator.id, operator]));
    if (query.operator_id && !byId.has(query.operator_id)) {
      throw new NotFoundException('Operator topilmadi');
    }
    const res = await this.send<{
      statusCode?: number;
      message?: string;
      data?: {
        items?: Array<Record<string, unknown> & { operator_id?: string }>;
        pagination?: unknown;
      };
    }>(this.financeClient, 'finance.operator.market_payment.list', {
      market_id: marketId,
      operator_ids: operators.map((operator) => operator.id),
      operator_id: query.operator_id,
      page: query.page,
      limit: query.limit,
    });
    return {
      ...res,
      data: {
        ...res?.data,
        items: (res?.data?.items ?? []).map((item) => ({
          ...item,
          operator_name: byId.get(String(item.operator_id))?.name ?? null,
        })),
      },
    };
  }

  @Post()
  @Roles(RoleEnum.MARKET)
  // Takroriy so'rov (ayni kalit) — tanadagi 200, yangi yozuv — 201.
  @UseInterceptors(BodyStatusCodeInterceptor)
  @ApiOperation({
    summary: "Market o'z operatoriga to'lovni yozadi (Elchi kassasiz)",
    description:
      "F2qp6FtE. Faqat hisob yozuvi: summa, sana (`paid_at`, sukut — bugun, kelajak — 400), izoh, kim yozdi (market). Asosiy kassa, kassa tarixi, «Maosh» xarajati, P&L daftari va smenaga TEGMAYDI. Qoldiqdan oshsa ham yoziladi (avans). `Idempotency-Key` MAJBURIY: ayni kalit bilan takror — 200 va o'sha yozuv (`idempotent: true`), ayni kalit boshqa to'lov bilan — 409. Jurnal: `finance.operator_payment_recorded`.",
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      "Har mantiqiy to'lov uchun bitta kalit (1-255 belgi); timeout'dan keyin qayta yuborishda — o'sha kalit.",
  })
  @ApiCreatedResponse({
    description: '{ statusCode: 201, message, data: OperatorPaymentViewDto }',
    type: OperatorPaymentViewDto,
  })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  @ApiConflictResponse({
    description: 'Idempotency-Key boshqa to`lov uchun ishlatilgan',
  })
  async record(
    @Req() req: { user: JwtUser },
    @Body() dto: RecordOperatorPaymentRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const marketId = this.ownMarketId(req);
    const key = String(idempotencyKey ?? '').trim();
    if (!key || key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key sarlavhasi majburiy (1-255 belgi)',
      );
    }
    const operators = await this.marketOperators(req, marketId);
    const operator = operators.find((item) => item.id === dto.operator_id);
    if (!operator) {
      throw new NotFoundException('Operator topilmadi');
    }
    const res = await this.send<{
      statusCode?: number;
      message?: string;
      data?: Record<string, unknown>;
    }>(this.financeClient, 'finance.operator.market_payment.record', {
      market_id: marketId,
      operator_id: dto.operator_id,
      amount: dto.amount,
      paid_at: dto.paid_at,
      note: dto.note,
      recorded_by_id: marketId,
      recorded_by_role: RoleEnum.MARKET,
      idempotency_key: key,
    });
    return {
      ...res,
      data: res?.data
        ? { ...res.data, operator_name: operator.name || null }
        : res?.data,
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market: xato to'lov yozuvini bekor qilish (sabab bilan)",
    description:
      "F2qp6FtE. Qator o'chirilmaydi: `status: cancelled`, `cancelled_at`, `cancel_reason`; «To'landi» ga kirmaydi. Faqat shu market yozgan yozuv (begona yoki yo'q — 404); eski Elchi (Asosiy kassadan) yozuvi — 409. Takroriy bekor — 200 (`idempotent: true`). Kassaga tegmaydi. Jurnal: `finance.operator_payment_cancelled`.",
  })
  @ApiParam({ name: 'id', description: "To'lov yozuvi ID" })
  @ApiOkResponse({
    description: '{ statusCode: 200, message, data: OperatorPaymentViewDto }',
    type: OperatorPaymentViewDto,
  })
  @ApiNotFoundResponse({ description: "To'lov topilmadi yoki begona" })
  @ApiConflictResponse({ description: "Eski Elchi to'lovi — bekor qilinmaydi" })
  cancel(
    @Req() req: { user: JwtUser },
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: CancelOperatorPaymentRequestDto,
  ) {
    const marketId = this.ownMarketId(req);
    return this.send(
      this.financeClient,
      'finance.operator.market_payment.cancel',
      {
        market_id: marketId,
        payment_id: id,
        reason: dto.reason,
        cancelled_by_id: marketId,
        cancelled_by_role: RoleEnum.MARKET,
      },
    );
  }
}
