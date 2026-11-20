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
  Logger,
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
  ListOperatorEarningsQueryDto,
  OperatorBalancesDto,
  OperatorEarningListDto,
  OperatorEarningViewDto,
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
  /** O'chirilgan operator (faqat `includeDeleted` bilan so'ralganda chiqadi). */
  deleted: boolean;
}

/** order-service `order.operator.order_counts` qatori. */
interface OperatorOrderCounts {
  total_orders: number;
  sold_orders: number;
  pending_orders: number;
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
  OperatorEarningViewDto,
  OperatorEarningListDto,
)
@ApiBearerAuth()
@Controller('finance/operator-payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperatorPaymentGatewayController {
  private readonly logger = new Logger(OperatorPaymentGatewayController.name);

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

  /**
   * Marketning barcha o'chirilmagan operatorlari (faol va nofaol).
   * `includeDeleted` (2026-11-20; hisob, tarix, daromad qatorlari) —
   * o'chirilganlari ham: ularning daromadi va to'lovlari market hisobidan
   * yo'qolmasin. To'lov YOZISH — avvalgidek faqat o'chirilmaganlarga.
   */
  private async marketOperators(
    req: { user: JwtUser },
    marketId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<MarketOperatorRef[]> {
    const operators: MarketOperatorRef[] = [];
    for (let page = 1; page <= OPERATOR_MAX_PAGES; page += 1) {
      const res = await this.send<{
        data?: {
          items?: Array<{
            id?: unknown;
            name?: unknown;
            status?: unknown;
            is_deleted?: unknown;
          }>;
          meta?: { totalPages?: unknown };
        };
      }>(this.identityClient, 'identity.market_operator.find_by_market', {
        market_id: marketId,
        query: {
          page,
          limit: OPERATOR_PAGE_LIMIT,
          ...(options.includeDeleted ? { include_deleted: true } : {}),
        },
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
          deleted: item.is_deleted === true,
        });
      }
      const totalPages = Number(res?.data?.meta?.totalPages ?? 1);
      if (items.length === 0 || !(page < totalPages)) break;
    }
    return operators;
  }

  /**
   * Har operator buyurtmalari soni (order-service). Qo'shimcha ma'lumot —
   * javob bermasa hisob baribir qaytadi (`null` — «noma'lum»), pulga ta'sir
   * qilmaydi.
   */
  private async operatorOrderCounts(
    marketId: string,
    operatorIds: string[],
  ): Promise<Map<string, OperatorOrderCounts> | null> {
    if (operatorIds.length === 0) return new Map();
    try {
      const res = await this.send<{
        data?: { items?: unknown };
        items?: unknown;
      }>(this.orderClient, 'order.operator.order_counts', {
        market_id: marketId,
        operator_ids: operatorIds,
      });
      const raw = res?.data?.items ?? res?.items;
      const counts = new Map<string, OperatorOrderCounts>();
      for (const item of Array.isArray(raw) ? raw : []) {
        const row = item as Record<string, unknown> | null;
        const rawId = row?.operator_id;
        const id =
          typeof rawId === 'string' || typeof rawId === 'number'
            ? String(rawId)
            : '';
        if (!BIGINT_ID_RE.test(id)) continue;
        counts.set(id, {
          total_orders: Number(row?.total_orders ?? 0) || 0,
          sold_orders: Number(row?.sold_orders ?? 0) || 0,
          pending_orders: Number(row?.pending_orders ?? 0) || 0,
        });
      }
      return counts;
    } catch (error) {
      this.logger.warn(
        `order.operator.order_counts ishlamadi (market ${marketId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  @Get('balances')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market: har operator — «Ishlab topdi / To'landi / Qoldiq»",
    description:
      "F2qp6FtE. Marketning barcha o'chirilmagan operatorlari (faol va nofaol), ism tartibida emas — identity ro'yxati tartibida. `earned` — o'chirilmagan daromadlar (`GET operators/me/balance` bilan AYNI qoida), `paid` — o'chirilmagan va bekor qilinmagan to'lovlar (eski Elchi to'lovlari ham), `balance` = earned − paid (manfiy — ortiqcha to'langan). `totals` — yig'indi. 2026-11-20: o'chirilgan operator ham (`status: deleted`) — faqat daromadi, to'lovi yoki yo'ldagi buyurtmasi bo'lsa; `orders_total` / `orders_sold` / `orders_pending` — operator buyurtmalari soni (komissiya faqat sotilganidan yoziladi; order-service javob bermasa — null).",
  })
  @ApiOkResponse({
    description: '{ statusCode, message, data: OperatorBalancesDto }',
    type: OperatorBalancesDto,
  })
  @ApiForbiddenResponse({ description: 'Market emas' })
  async balances(@Req() req: { user: JwtUser }) {
    const marketId = this.ownMarketId(req);
    const operators = await this.marketOperators(req, marketId, {
      includeDeleted: true,
    });
    const operatorIds = operators.map((operator) => operator.id);
    const [res, counts] = await Promise.all([
      this.send<{
        statusCode?: number;
        message?: string;
        data?: {
          items?: Array<
            Record<string, unknown> & {
              operator_id?: string;
              earned?: unknown;
              paid?: unknown;
            }
          >;
          totals?: unknown;
        };
      }>(this.financeClient, 'finance.operator.market_balances', {
        operator_ids: operatorIds,
      }),
      this.operatorOrderCounts(marketId, operatorIds),
    ]);
    const byId = new Map(operators.map((operator) => [operator.id, operator]));
    return {
      ...res,
      data: {
        ...res?.data,
        items: (res?.data?.items ?? [])
          .map((item) => {
            const id = String(item.operator_id);
            const operator = byId.get(id);
            const count = counts?.get(id);
            return {
              ...item,
              operator_name: operator?.name ?? '',
              status: operator?.deleted
                ? 'deleted'
                : (operator?.status ?? 'active'),
              orders_total: counts ? (count?.total_orders ?? 0) : null,
              orders_sold: counts ? (count?.sold_orders ?? 0) : null,
              orders_pending: counts ? (count?.pending_orders ?? 0) : null,
            };
          })
          // O'chirilgan operator — faqat hisobida nimadir bo'lsa (bo'sh
          // qatorlar ro'yxatni to'ldirmasin). `totals` ga ta'sir yo'q: bo'sh
          // qatorning summasi 0.
          .filter(
            (item) =>
              item.status !== 'deleted' ||
              Number(item.earned ?? 0) !== 0 ||
              Number(item.paid ?? 0) !== 0 ||
              Number(item.orders_pending ?? 0) > 0,
          ),
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
    // 2026-11-20: o'chirilgan operatorlarning to'lovlari ham (ism bilan).
    const operators = await this.marketOperators(req, marketId, {
      includeDeleted: true,
    });
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

  @Get('earnings')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: 'Market: operator daromad qatorlari (qaysi buyurtmadan qancha)',
    description:
      "2026-11-20. «Ishlab topdi» ning tarkibi: har sotilgan buyurtma uchun yozilgan operator ulushi (yangisi tepada). `operator_id` — shu marketning operatori (o'chirilgani ham; begona yoki yo'q — 404). Rollback qilingan (o'chirilgan) qatorlar chiqmaydi — «Ishlab topdi» bilan AYNI qoida. Komissiya sotuv paytidagi stavka bo'yicha (snapshot).",
  })
  @ApiOkResponse({
    description: '{ statusCode, message, data: OperatorEarningListDto }',
    type: OperatorEarningListDto,
  })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  async earnings(
    @Req() req: { user: JwtUser },
    @Query() query: ListOperatorEarningsQueryDto,
  ) {
    const marketId = this.ownMarketId(req);
    const operators = await this.marketOperators(req, marketId, {
      includeDeleted: true,
    });
    if (!operators.some((operator) => operator.id === query.operator_id)) {
      throw new NotFoundException('Operator topilmadi');
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const res = await this.send<{
      statusCode?: number;
      message?: string;
      data?: { rows?: unknown; total?: unknown };
    }>(this.financeClient, 'finance.operator.earning.list', {
      operator_id: query.operator_id,
      limit,
      offset: (page - 1) * limit,
    });
    const rows = Array.isArray(res?.data?.rows) ? res.data.rows : [];
    const total = Number(res?.data?.total ?? 0) || 0;
    const asText = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    return {
      statusCode: res?.statusCode ?? 200,
      message: res?.message ?? 'operator earnings',
      data: {
        // Faqat ko'rsatish maydonlari — ichki `operator_id`, `market_id`,
        // `is_deleted` qaytmaydi.
        items: rows.map((item) => {
          const row = (item ?? {}) as Record<string, unknown>;
          const createdAt = row.createdAt ?? row.created_at;
          return {
            id: asText(row.id),
            order_id: asText(row.order_id),
            amount: Number(row.amount ?? 0) || 0,
            order_total_price: Number(row.order_total_price ?? 0) || 0,
            commission_type:
              typeof row.commission_type === 'string'
                ? row.commission_type
                : null,
            commission_value: Number(row.commission_value ?? 0) || 0,
            created_at:
              createdAt instanceof Date
                ? createdAt.toISOString()
                : asText(createdAt),
          };
        }),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
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
