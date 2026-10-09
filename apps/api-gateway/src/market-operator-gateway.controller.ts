import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateMarketOperatorRequestDto,
  UpdateMarketOperatorCommissionRequestDto,
} from './dto/market-operator.swagger.dto';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';

interface JwtUser {
  sub: string;
  roles?: string[];
}

const BIGINT_ID_RE = /^[0-9]{1,19}$/;

/** identity'ga RPC: create — bcrypt + 2-3 DB o'qish; boshqa yo'llar bilan bir xil 8 s. */
const MARKET_OPERATOR_RPC_TIMEOUT_MS = 8000;

/**
 * Market operatorlari (i76gGjyq) — market O'Z xodimlarini boshqaradi.
 *
 * Ilgari frontend /market-operators sahifasi `GET /users?role=operator` ni
 * chaqirardi: u faqat SUPERADMIN/ADMIN/MANAGER uchun ochiq (market → 403),
 * market bo'yicha ko'lamlanmagan va rol nomi `operator` edi — biznes mantiq
 * esa `market_operator` ga tayanadi. Yaratish endpointi umuman yo'q edi.
 *
 * KO'LAM: market so'rovida market_id HAR DOIM JWT `sub` — mijoz yuborgan
 * market_id ishlatilmaydi (GET'da boshqa market_id → 400, tanada →
 * forbidNonWhitelisted 400). Identity uni requester bilan qayta tekshiradi;
 * begona operator — 404 (id mavjudligi oshkor qilinmaydi).
 *
 * Barcha yo'llar FAQAT MARKET uchun (karta: "@Roles(MARKET), requester.sub =
 * market_id majburiy" — BeePost `getMyOperators` ko'lam modeli). Admin uchun
 * mavjud `/users` yo'llari bor.
 */
@ApiTags('Market operators')
@ApiBearerAuth()
@Controller('market-operators')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketOperatorGatewayController {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private send(cmd: string, payload: object) {
    return this.identityClient
      .send({ cmd }, payload)
      .pipe(timeout(MARKET_OPERATOR_RPC_TIMEOUT_MS));
  }

  private toRequester(req: { user: JwtUser }) {
    return { id: String(req.user.sub), roles: req.user.roles ?? [] };
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
        "Operatorlarni faqat market o'zi boshqara oladi",
      );
    }
    return sub;
  }

  /** GET ko'lami: market — o'zi (boshqa `market_id` → 400, o'zinikini takrorlash mumkin). */
  private resolveListMarketId(
    req: { user: JwtUser },
    requestedMarketId?: string,
  ): string {
    const roles = this.rolesOf(req);
    const requested = String(requestedMarketId ?? '').trim();
    if (roles.includes(RoleEnum.MARKET)) {
      const own = this.ownMarketId(req);
      if (
        requested &&
        (!BIGINT_ID_RE.test(requested) || BigInt(requested) !== BigInt(own))
      ) {
        throw new BadRequestException(
          "Market faqat o'z operatorlarini ko'ra oladi (market_id yubormang)",
        );
      }
      return own;
    }
    throw new ForbiddenException('Bu amal uchun ruxsat yoq');
  }

  @Get()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: "Market operatorlari ro'yxati (faqat market — o'ziniki)",
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    example: 'active',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 100 })
  @ApiQuery({
    name: 'market_id',
    required: false,
    type: String,
    description: 'Ixtiyoriy; faqat o`z id`ingiz. Boshqa market_id → 400',
  })
  @ApiOkResponse({
    description:
      '{ items: MarketOperator[], meta: { page, limit, total, totalPages } }',
  })
  @ApiForbiddenResponse({ description: 'Market emas' })
  list(
    @Req() req: { user: JwtUser },
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('market_id') marketId?: string,
  ) {
    const scopedMarketId = this.resolveListMarketId(req, marketId);
    return this.send('identity.market_operator.find_by_market', {
      market_id: scopedMarketId,
      query: {
        search,
        status,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
      requester: this.toRequester(req),
    });
  }

  @Post()
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: 'Market o`z operatorini yaratadi (rol: market_operator)',
  })
  @ApiBody({ type: CreateMarketOperatorRequestDto })
  @ApiCreatedResponse({ description: 'Operator yaratildi' })
  @ApiConflictResponse({ description: 'Telefon raqam band' })
  @ApiForbiddenResponse({ description: 'Market emas yoki market bloklangan' })
  create(
    @Body() dto: CreateMarketOperatorRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('identity.market_operator.create', {
      market_id: this.ownMarketId(req),
      dto: {
        name: dto.name,
        phone_number: dto.phone_number,
        password: dto.password,
      },
      requester: this.toRequester(req),
    });
  }

  @Patch(':id/commission')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      'Operator komissiyasi (percent | fixed | null) — faqat o`z operatori',
  })
  @ApiParam({ name: 'id', description: 'Operator ID' })
  @ApiBody({ type: UpdateMarketOperatorCommissionRequestDto })
  @ApiOkResponse({ description: 'Komissiya yangilandi' })
  @ApiBadRequestResponse({ description: 'Chegaradan tashqari qiymat' })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  updateCommission(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: UpdateMarketOperatorCommissionRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('identity.market_operator.update_commission', {
      id,
      market_id: this.ownMarketId(req),
      dto: {
        commission_type: dto.commission_type,
        commission_value: dto.commission_value,
      },
      requester: this.toRequester(req),
    });
  }

  @Delete(':id')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary: 'Operatorni o`chirish (soft) — faqat o`z operatori',
  })
  @ApiParam({ name: 'id', description: 'Operator ID' })
  @ApiOkResponse({ description: "Operator o'chirildi" })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  remove(
    @Param('id', ParseBigintIdPipe) id: string,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('identity.market_operator.delete', {
      id,
      market_id: this.ownMarketId(req),
      requester: this.toRequester(req),
    });
  }
}
