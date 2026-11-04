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
import { firstValueFrom, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { resolveMarketOperatorMarketId } from './auth/market-operator-market';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateMarketOperatorRequestDto,
  UpdateMarketOperatorCommissionRequestDto,
  UpdateMarketOperatorStatusRequestDto,
  UpdateMarketOperatorWarehouseAccessRequestDto,
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
 * Boshqaruv yo'llari FAQAT MARKET uchun (karta: "@Roles(MARKET), requester.sub =
 * market_id majburiy" — BeePost `getMyOperators` ko'lam modeli). Admin uchun
 * mavjud `/users` yo'llari bor. Istisno — `GET selectable` (buyurtma
 * formasidagi «Operator» tanlovi, faqat `{ id, name }`): buyurtma yaratadigan
 * rollarga ochiq, market esa rol bo'yicha serverda aniqlanadi.
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

  /**
   * «Operator» tanlovi ko'lami — `POST /orders` dagi yakuniy market bilan
   * AYNI (tanlangan operator yaratishda shu market bo'yicha tekshiriladi):
   *  - MARKET — o'zi (JWT sub); boshqa `market_id` → 400;
   *  - MARKET_OPERATOR — biriktirilgan marketi (identity `user.market_id`);
   *    boshqa `market_id` → 400, biriktirilmagan → 400;
   *  - qolganlar (superadmin, admin, registrator, menejer, filial) —
   *    formada tanlangan `market_id` MAJBURIY.
   */
  private async resolveSelectableMarketId(
    req: { user: JwtUser },
    requestedMarketId?: string,
  ): Promise<string> {
    const roles = this.rolesOf(req);
    if (roles.includes(RoleEnum.MARKET)) {
      return this.resolveListMarketId(req, requestedMarketId);
    }
    const requested = String(requestedMarketId ?? '').trim();
    if (requested && !BIGINT_ID_RE.test(requested)) {
      throw new BadRequestException("market_id noto'g'ri");
    }
    if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      const own = await resolveMarketOperatorMarketId(
        this.identityClient,
        req?.user?.sub,
      );
      if (!BIGINT_ID_RE.test(own)) {
        throw new BadRequestException(
          'Operator hech qaysi marketga biriktirilmagan',
        );
      }
      if (requested && BigInt(requested) !== BigInt(own)) {
        throw new BadRequestException(
          "Market operatori faqat o'z marketi operatorlarini ko'ra oladi (market_id yubormang)",
        );
      }
      return own;
    }
    if (!requested) {
      throw new BadRequestException('market_id majburiy');
    }
    return requested;
  }

  // ⚠️ `:id` li yo'llardan OLDIN e'lon qilingan (statik `selectable`
  // segmenti hech qachon id sifatida ushlanmasin).
  @Get('selectable')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiOperation({
    summary:
      'Buyurtma formasidagi «Operator» tanlovi — marketning faol operatorlari',
    description:
      "BeePost `GET user/operators/selectable` kabi. Faqat faol, o'chirilmagan market operatorlari — `{ id, name }`, " +
      'ism bo`yicha (katta-kichik harf farqsiz). Market — o`zi (boshqa `market_id` → 400); market operatori — ' +
      'biriktirilgan marketi (boshqa `market_id` → 400, biriktirilmagan → 400); superadmin, admin, registrator, ' +
      'menejer, filial — `market_id` MAJBURIY. Tanlangan id `POST /orders` `operator_id` ga yuboriladi.',
  })
  @ApiQuery({
    name: 'market_id',
    required: false,
    type: String,
    description:
      'Market ID. Market / market operatori uchun ixtiyoriy (faqat o`ziniki); qolgan rollar uchun majburiy',
  })
  @ApiOkResponse({
    description:
      '{ statusCode: 200, message, data: { items: [{ id: string, name: string }] } }',
  })
  @ApiBadRequestResponse({
    description:
      "market_id yo'q / noto'g'ri / begona; operator marketga biriktirilmagan",
  })
  @ApiForbiddenResponse({ description: 'Rol ruxsat etilmagan' })
  async selectable(
    @Req() req: { user: JwtUser },
    @Query('market_id') marketId?: string,
  ) {
    const scopedMarketId = await this.resolveSelectableMarketId(req, marketId);
    return firstValueFrom<unknown>(
      this.send('identity.market_operator.selectable', {
        market_id: scopedMarketId,
      }),
    );
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
      '{ items: MarketOperator[], meta: { page, limit, total, totalPages } }. Har qatorda `can_view_warehouse_stock: boolean` (sukut false, XtcEyQjb).',
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
    description:
      "B3ZtzCCx: ixtiyoriy komissiya (`commission_type` + `commission_value`, ikkalasi BIRGA) AYNI so'rovda — operator va komissiya bitta yozuvda (atomik). Cheklovlar `PATCH :id/commission` bilan bir xil: percent 0..100, fixed 0..1 000 000 so'm, 2 kasr. Noto'g'ri komissiya — 400 va operator YARATILMAYDI.",
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
        // B3ZtzCCx: berilgan bo'lsagina uzatiladi (identity ikkalasini birga
        // va PATCH chegaralari bilan tekshiradi).
        ...(dto.commission_type !== undefined
          ? { commission_type: dto.commission_type }
          : {}),
        ...(dto.commission_value !== undefined
          ? { commission_value: dto.commission_value }
          : {}),
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

  @Patch(':id/warehouse-access')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      '«Ombordagi qoldiq»ni ko`rish ruxsati (can_view_warehouse_stock) — faqat o`z operatori',
    description:
      "XtcEyQjb: market o'zi har operatoriga alohida yoqadi/o'chiradi (sukut o'chiq). Yoqilgan operator `GET /market/warehouse-stock` da biriktirilgan marketi qoldig'ini ko'radi, o'chiq — 403 `{ code: \"WAREHOUSE_STOCK_FORBIDDEN\" }`. Javob — operator qatori (`can_view_warehouse_stock` bilan). Jurnal: `identity.market_operator_warehouse_access_changed`.",
  })
  @ApiParam({ name: 'id', description: 'Operator ID' })
  @ApiBody({ type: UpdateMarketOperatorWarehouseAccessRequestDto })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: MarketOperator } — `data.can_view_warehouse_stock`',
  })
  @ApiBadRequestResponse({ description: 'Qiymat boolean emas' })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  updateWarehouseAccess(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: UpdateMarketOperatorWarehouseAccessRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('identity.market_operator.update_warehouse_access', {
      id,
      market_id: this.ownMarketId(req),
      dto: { can_view_warehouse_stock: dto.can_view_warehouse_stock },
      requester: this.toRequester(req),
    });
  }

  @Patch(':id/status')
  @Roles(RoleEnum.MARKET)
  @ApiOperation({
    summary:
      'Operatorni nofaol / qayta faol qilish — faqat o`z operatori (mFkrqvMi)',
    description:
      "Ega qarori 2026-10-19 (MO-S4). `inactive` — operator kira olmaydi: barcha sessiyalari yopiladi (refresh token tozalanadi, qurilma keyingi refresh'da chiqariladi), Telegram bot uni aktor deb tanimaydi. `active` — qayta faol (market o'zi bloklangan bo'lsa 403). Buyurtmalar, komissiya va daromad tarixi o'zgarmaydi. Holat o'zgarmasa ham 200. Javob — operator qatori (`status` bilan). Jurnal: `status_change` (muallif — market).",
  })
  @ApiParam({ name: 'id', description: 'Operator ID' })
  @ApiBody({ type: UpdateMarketOperatorStatusRequestDto })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: MarketOperator } — `data.status`',
  })
  @ApiBadRequestResponse({ description: "status 'active' | 'inactive' emas" })
  @ApiForbiddenResponse({
    description: 'Market emas yoki market bloklangan (faollashtirish)',
  })
  @ApiNotFoundResponse({ description: 'Operator topilmadi yoki begona' })
  updateStatus(
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: UpdateMarketOperatorStatusRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('identity.market_operator.set_status', {
      id,
      market_id: this.ownMarketId(req),
      dto: { status: dto.status },
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
