import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  MARKET_OPERATOR_SELECTABLE_CMD,
  resolveChosenOrderOperator,
} from './order-create/order-chosen-operator';

interface JwtUser {
  sub: string;
  roles?: string[];
}

const BIGINT_ID_RE = /^[1-9]\d{0,18}$/;
/** Bir so'rovda biriktiriladigan buyurtmalar (frontend katta guruhni bo'laklab yuboradi). */
export const UNLINKED_ASSIGN_MAX_ORDERS = 100;
/** Ro'yxat — bitta guruhlash so'rovi. */
const LIST_TIMEOUT_MS = 15_000;
/** 100 tagacha buyurtma — har biri o'z tranzaksiyasida, ketma-ket. */
const ASSIGN_TIMEOUT_MS = 60_000;
const IDENTITY_TIMEOUT_MS = 8_000;

export class AssignUnlinkedOrdersRequestDto {
  @ApiProperty({
    example: '41',
    description:
      'Shu marketning FAOL operatori (`GET /market-operators/selectable` ro`yxatidan). Begona / nofaol — 400.',
  })
  @IsString({ message: 'operator_id majburiy' })
  @Matches(BIGINT_ID_RE, {
    message: "operator_id operator ID si (raqam) bo'lishi kerak",
  })
  operator_id!: string;

  @ApiProperty({
    type: [String],
    example: ['55120', '55121'],
    description: `Biriktiriladigan buyurtmalar (1…${UNLINKED_ASSIGN_MAX_ORDERS}) — odatda \`GET market-operators/unlinked-orders\` guruhidagi \`order_ids\``,
  })
  @IsArray({ message: "order_ids ro'yxat bo'lishi kerak" })
  @ArrayMinSize(1, { message: 'order_ids majburiy' })
  @ArrayMaxSize(UNLINKED_ASSIGN_MAX_ORDERS, {
    message: `order_ids ko'pi bilan ${UNLINKED_ASSIGN_MAX_ORDERS} ta`,
  })
  @IsString({ each: true, message: "order_ids noto'g'ri" })
  @Matches(BIGINT_ID_RE, { each: true, message: "order_ids noto'g'ri" })
  order_ids!: string[];
}

/**
 * 2026-11-20 — ega: «operator nomidan yaratilgan buyurtmalarga xizmat haqqi
 * yozilmayapti va ko'rsatilmayapti». Eski buyurtmalarda operator ismi faqat
 * MATN bo'lib qolgan (`operator_id` yo'q) — sotuvda komissiya yozilmagan.
 * Market ularni ism bo'yicha guruhlab ko'radi va har guruhga operatorni O'ZI
 * tanlab, ommaviy biriktiradi. Avtomatik bog'lash yo'q.
 *
 * FAQAT MARKET (o'z buyurtmalari, market = JWT `sub`). Biriktirish — mavjud
 * `PUT /orders/:id/operator` qoidasi bilan AYNI: operator shu marketning faol
 * operatori (`resolveChosenOrderOperator`, bir marta), har buyurtma
 * order-service'da qulf ostida (operator bor — 409, integratsiya — 409,
 * begona — 403); sotilgan buyurtmada ulush sotuvdagidek yoziladi.
 */
@ApiTags('Market operators')
@ApiBearerAuth()
@Controller('market-operators/unlinked-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketOperatorOrdersGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private rolesOf(req: { user: JwtUser }): string[] {
    return (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  private ownMarketId(req: { user: JwtUser }): string {
    const sub = String(req?.user?.sub ?? '').trim();
    if (
      !this.rolesOf(req).includes(RoleEnum.MARKET) ||
      !BIGINT_ID_RE.test(sub)
    ) {
      throw new ForbiddenException(
        "Buyurtmalarga operatorni faqat market o'zi biriktira oladi",
      );
    }
    return sub;
  }

  private send<T = unknown>(
    client: ClientProxy,
    cmd: string,
    payload: object,
    timeoutMs: number,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }

  @Get()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      "Market: operator ismi yozilgan, lekin operatorga bog'lanmagan buyurtmalar (ism bo'yicha guruh)",
    description:
      "2026-11-20. Shu marketda `operator_id` yo'q, lekin `operator` matni bor buyurtmalar (integratsiya `external_*` dan tashqari) — ism bo'yicha guruhlar (`#`, katta-kichik harf va bo'shliqlar farq qilmaydi), eng ko'pi birinchi, ko'pi bilan 200 guruh. Har guruhda: `name`, `key`, `total_orders`, `sold_orders` (biriktirilsa ulush darhol yoziladi), `order_ids` (eng yangisi birinchi, ko'pi bilan 500).",
  })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: { groups: [{ name, key, total_orders, sold_orders, order_ids }], total_orders } }',
  })
  @ApiForbiddenResponse({ description: 'Market emas' })
  list(@Req() req: { user: JwtUser }) {
    return this.send(
      this.orderClient,
      'order.operator.unlinked',
      { market_id: this.ownMarketId(req) },
      LIST_TIMEOUT_MS,
    );
  }

  @Post('assign')
  @HttpCode(200)
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market: bir operatorni ko'p buyurtmaga biriktirish",
    description:
      "2026-11-20. `PUT /orders/:id/operator` bilan AYNI qoida, ko'p buyurtmaga: operator — shu marketning faol operatori (bir marta tekshiriladi, aks holda 400); har buyurtma alohida (operatori bor — 409 `ORDER_OPERATOR_ALREADY_ASSIGNED`, integratsiya — 409, begona — 403) — bittasi yiqilsa qolganlari davom etadi. Sotilgan buyurtmada operator ulushi sotuvdagidek yoziladi. Javob: `{ assigned, failed, earnings_recorded, results: [{ id, ok, earning_recorded?, status_code?, code?, message? }] }`.",
  })
  @ApiBody({ type: AssignUnlinkedOrdersRequestDto })
  @ApiOkResponse({ description: '{ statusCode, message, data }' })
  @ApiBadRequestResponse({
    description: "Operator bu marketniki emas / faol emas; order_ids noto'g'ri",
  })
  @ApiForbiddenResponse({ description: 'Market emas' })
  async assign(
    @Req() req: { user: JwtUser },
    @Body() dto: AssignUnlinkedOrdersRequestDto,
  ) {
    const marketId = this.ownMarketId(req);
    const roles = this.rolesOf(req);
    const chosen = await resolveChosenOrderOperator({
      operatorId: dto.operator_id,
      roles,
      requesterId: req.user.sub,
      marketId,
      loadSelectable: (payload) =>
        this.send(
          this.identityClient,
          MARKET_OPERATOR_SELECTABLE_CMD,
          payload,
          IDENTITY_TIMEOUT_MS,
        ),
    });
    if (!chosen) {
      throw new BadRequestException('operator_id majburiy');
    }
    return this.send(
      this.orderClient,
      'order.operator.assign_bulk',
      {
        order_ids: dto.order_ids,
        operator_id: chosen.id,
        operator_name: chosen.name || null,
        market_id: marketId,
        requester: { id: marketId, roles, market_id: marketId },
      },
      ASSIGN_TIMEOUT_MS,
    );
  }
}
