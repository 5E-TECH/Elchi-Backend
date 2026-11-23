import {
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Logger,
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
/** 20 × 5000 = 100 000 sotuv; undan ko'pi — `truncated: true`. */
const SOLD_PAGE_MAX = 20;

/** order-service `order.operator.sold_orders` javobi (eski va yangi shakl). */
interface SoldOrdersBody {
  items?: unknown;
  truncated?: unknown;
  next_after_id?: unknown;
  cursor?: unknown;
  filtered_by_ids?: unknown;
}
type SoldOrdersResponse = SoldOrdersBody & { data?: SoldOrdersBody };

/** finance `finance.operator.earning.backfill` javobi. */
interface BackfillResponse {
  statusCode?: number;
  message?: string;
  data?: Record<string, unknown> & { created_order_ids?: unknown };
}

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
  private readonly logger = new Logger(
    OperatorEarningBackfillGatewayController.name,
  );

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

  /** order-service `order.operator.sold_orders` — bitta sahifa. */
  private async soldOrders(
    marketId: string,
    operatorId: string,
    extra: { after_id?: string; order_ids?: string[] } = {},
  ): Promise<{
    items: unknown[];
    truncated: boolean;
    nextAfterId: string | null;
    /** Yangi servis (sahifalash va `order_ids` filtrini biladi). */
    cursor: boolean;
    filteredByIds: boolean;
  }> {
    const res = await this.send<SoldOrdersResponse>(
      this.orderClient,
      'order.operator.sold_orders',
      { market_id: marketId, operator_id: operatorId, ...extra },
    );
    const body = res?.data ?? res;
    const next = body?.next_after_id;
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      truncated: body?.truncated === true,
      nextAfterId:
        typeof next === 'string' && BIGINT_ID_RE.test(next) ? next : null,
      cursor: body?.cursor === 'id_asc',
      filteredByIds: body?.filtered_by_ids === true,
    };
  }

  /**
   * Audit 2026-11-22 #8: backfill sotilganlar ro'yxatini qulfsiz oladi. Shu
   * orada buyurtma sotuvdan chiqsa (rollback), `finance.operator.earning.remove`
   * yozuvdan OLDIN kelib «o'chiradigan qator yo'q» bilan o'tib ketadi va keyin
   * backfill tirik ulush yozadi. Shuning uchun yozilgan buyurtmalar
   * order-service'da QAYTA tekshiriladi va endi sotilmaganlarining ulushi
   * olib tashlanadi (yozuvdan keyingi rollback'ni oddiy remove o'zi ushlaydi).
   * Qayta tekshiruv ishlamasa — ogohlantirish logi, javob baribir qaytadi
   * (ulushlar yozilib bo'lgan; takroriy bosish ham xavfsiz).
   */
  private async revokeNoLongerSold(
    marketId: string,
    operatorId: string,
    createdOrderIds: string[],
  ): Promise<number> {
    if (createdOrderIds.length === 0) return 0;
    try {
      const still = await this.soldOrders(marketId, operatorId, {
        order_ids: createdOrderIds,
      });
      // Eski order-service `order_ids` ni bilmaydi va oddiy ro'yxatni beradi —
      // u bo'yicha o'chirish to'g'ri ulushlarni ham o'chirardi.
      if (!still.filteredByIds) {
        this.logger.warn(
          `backfill qayta tekshiruvi o'tkazib yuborildi (order-service order_ids filtrini bilmaydi), operator ${operatorId}`,
        );
        return 0;
      }
      const sold = new Set(
        still.items
          .map((item) => {
            const id = (item as { order_id?: unknown } | null)?.order_id;
            return typeof id === 'string' || typeof id === 'number'
              ? String(id)
              : '';
          })
          .filter((id) => id !== ''),
      );
      let revoked = 0;
      for (const orderId of createdOrderIds) {
        if (sold.has(orderId)) continue;
        await this.send(this.financeClient, 'finance.operator.earning.remove', {
          order_id: orderId,
        });
        revoked += 1;
      }
      if (revoked > 0) {
        this.logger.warn(
          `backfill: ${revoked} ta buyurtma yozish paytida sotuvdan chiqqan — ulushi olib tashlandi (operator ${operatorId})`,
        );
      }
      return revoked;
    } catch (error) {
      this.logger.warn(
        `backfill qayta tekshiruvi ishlamadi (operator ${operatorId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /**
   * Audit 2026-11-22 #9: sotuvlar 5000 talik sahifalarda (id o'sish tartibida)
   * o'qiladi va har sahifa finance'ga alohida beriladi; natija yig'iladi.
   * Avval faqat eng yangi 5000 ta olinardi — undan eskilari hech qachon
   * hisoblanmasdi, dialog esa «hammasi yozilgan» derdi. `truncated` endi faqat
   * {@link SOLD_PAGE_MAX} sahifadan (100 000 sotuv) oshganda yoki order-service
   * hali eski (sahifalashni bilmaydi) bo'lganda `true`.
   */
  private async run(
    req: { user: JwtUser },
    operatorId: string,
    dryRun: boolean,
  ) {
    const marketId = this.ownMarketId(req);
    const operator = await this.assertOwnOperator(marketId, operatorId);
    const totals = {
      sold_orders: 0,
      already_recorded: 0,
      missing: 0,
      to_record: 0,
      amountCents: 0,
      created: 0,
      createdCents: 0,
      revoked: 0,
    };
    let last: BackfillResponse | null = null;
    let commission: { type: unknown; value: unknown } | null = null;
    let afterId: string | undefined;
    let complete = false;
    for (let page = 0; page < SOLD_PAGE_MAX; page += 1) {
      const sold = await this.soldOrders(
        marketId,
        operatorId,
        afterId ? { after_id: afterId } : {},
      );
      const res = await this.send<BackfillResponse>(
        this.financeClient,
        'finance.operator.earning.backfill',
        {
          operator_id: operatorId,
          orders: sold.items,
          dry_run: dryRun,
          requested_by: { id: marketId, role: RoleEnum.MARKET },
        },
      );
      last = res;
      const data = res?.data ?? {};
      const num = (value: unknown) => Number(value ?? 0) || 0;
      totals.sold_orders += num(data.sold_orders);
      totals.already_recorded += num(data.already_recorded);
      totals.missing += num(data.missing);
      totals.to_record += num(data.to_record);
      totals.amountCents += Math.round(num(data.amount) * 100);
      totals.created += num(data.created);
      totals.createdCents += Math.round(num(data.created_amount) * 100);
      if (!commission || commission.type == null) {
        commission = {
          type: data.commission_type ?? null,
          value: data.commission_value ?? 0,
        };
      }
      if (!dryRun && Array.isArray(data.created_order_ids)) {
        totals.revoked += await this.revokeNoLongerSold(
          marketId,
          operatorId,
          data.created_order_ids.filter(
            (id): id is string =>
              typeof id === 'string' && BIGINT_ID_RE.test(id),
          ),
        );
      }
      if (!sold.truncated) {
        complete = true;
        break;
      }
      // Eski order-service (`cursor` yo'q) har safar aynan o'sha sahifani
      // qaytaradi — aylanib qolmaslik uchun to'xtaymiz.
      if (
        !sold.cursor ||
        !sold.nextAfterId ||
        (afterId !== undefined && BigInt(sold.nextAfterId) <= BigInt(afterId))
      ) {
        break;
      }
      afterId = sold.nextAfterId;
    }
    return {
      statusCode: last?.statusCode ?? 200,
      message: dryRun
        ? 'operator earnings backfill preview'
        : 'operator earnings backfilled',
      data: {
        operator_id: operatorId,
        sold_orders: totals.sold_orders,
        already_recorded: totals.already_recorded,
        missing: totals.missing,
        commission_type: commission?.type ?? null,
        commission_value: Number(commission?.value ?? 0) || 0,
        to_record: totals.to_record,
        amount: totals.amountCents / 100,
        created: totals.created,
        ...(dryRun
          ? {}
          : {
              created_amount: totals.createdCents / 100,
              revoked: totals.revoked,
            }),
        dry_run: dryRun,
        operator_name: operator.name || null,
        truncated: !complete,
      },
    };
  }

  @Get()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      'Market: operatorning komissiyasiz qolgan sotuvlari — oldindan ko`rish',
    description:
      "2026-11-20. Hech narsa yozilmaydi. `{ sold_orders, already_recorded, missing, to_record, amount, commission_type, commission_value, operator_name, truncated }` — `to_record` / `amount`: joriy stavka bo'yicha yoziladigan qatorlar va summa (stavka yo'q — 0). Barcha sotuvlar 5000 talik sahifalarda ko'riladi (audit 2026-11-22 #9); `truncated: true` — faqat 100 000 dan ortiq sotuvda (ko'rilmagan qismi qoldi).",
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
      "2026-11-20. Faqat daftarda qatori umuman yo'q (rollback qilinmagan) hozir sotilgan buyurtmalar; mavjud qatorlar o'zgarmaydi. Takror — ikkinchi qator yo'q (`created: 0`). Javob: oldindan ko'rish maydonlari + `created`, `created_amount`, `revoked` — yozish paytida sotuvdan chiqqan buyurtmalar soni (ulushi darhol olib tashlandi, audit 2026-11-22 #8). Barcha sotuvlar sahifalab yoziladi (#9). Elchi kassasiga ta'sir yo'q.",
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
