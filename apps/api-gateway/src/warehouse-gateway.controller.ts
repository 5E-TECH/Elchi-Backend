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
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum, WAREHOUSE_RPC } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateWarehouseRequestDto,
  MarketWarehouseStockResponseDto,
  UpdateMarketWarehouseOrderRequestDto,
  UpdateWarehouseRequestDto,
  WarehouseAvailabilityResponseDto,
  WarehouseDetailDto,
  WarehouseInventoryRequestDto,
  WarehouseInventoryResponseDto,
  WarehouseListResponseDto,
  WarehouseLookupResponseDto,
  WarehouseMovementListResponseDto,
  WarehouseResolveSourceRequestDto,
  WarehouseResolveSourceResponseDto,
  WarehouseStatusRequestDto,
  WarehouseStockInRequestDto,
  WarehouseStockInResponseDto,
  WarehouseStockListResponseDto,
  WarehouseThresholdRequestDto,
  WarehouseThresholdResponseDto,
} from './dto/warehouse.swagger.dto';
import { buildXlsx, excelDate } from './excel/excel.util';

interface JwtUser {
  sub: string;
  roles?: string[];
  branch_id?: string | null;
}

type Req = { user: JwtUser };

/** Kirim, inventarizatsiya, ombor ochish/tahrir, pauza — qaror 3. */
export const WAREHOUSE_ADMIN_ROLES = [RoleEnum.SUPERADMIN, RoleEnum.ADMIN];

/**
 * O'qish: SUPERADMIN/ADMIN — hamma ombor; filial menejeri (MANAGER) va filial
 * akkaunti (BRANCH) — FAQAT o'z filiali ombori (qaror 10; begonasi 404).
 */
export const WAREHOUSE_READ_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
];

/**
 * Buyurtma yaratish formasi (manba tanlovi, «Omborda: N») — qaror 5:
 * superadmin, admin, registrator; market (va uning operatori) — faqat o'z
 * mahsulotlari, kalit `can_order_from_warehouse` o'chiq bo'lsa manba HQ.
 */
export const WAREHOUSE_ORDER_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
];

/** «Ombordagi qoldiq»: market — faqat o'zi; admin — `market_id` bilan. */
export const MARKET_STOCK_ROLES = [
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
];

const CATALOG_TIMEOUT_MS = 10_000;
const ID_PATTERN = /^[1-9]\d{0,18}$/;

const LEVEL_LABEL: Record<string, string> = {
  ok: 'Yetarli',
  low: 'Kam qoldi',
  out: 'Tugagan',
};

/**
 * hY7uacJu — vaqtinchalik ombor moduli (HTTP → catalog-service RMQ).
 *
 * Qoldiq faqat dona; har o'zgarish `stock_movements` ga yoziladi. Kirim va
 * inventarizatsiya `Idempotency-Key` bilan — qayta yuborilgan AYNI so'rov
 * ikkinchi marta yozmaydi (`replayed: true`). Buyurtma bilan bog'lanish
 * (reserve/out/release/return) — order-service RMQ orqali, HTTP'da yo'q.
 */
@ApiTags('Warehouses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class WarehouseGatewayController {
  constructor(
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  // ------------------------------------------------------------------
  // Yordamchilar
  // ------------------------------------------------------------------

  private send<T = unknown>(cmd: string, payload: object): Promise<T> {
    return firstValueFrom(
      this.catalogClient
        .send<T>({ cmd }, payload)
        .pipe(timeout(CATALOG_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Catalog service response timeout');
      }
      throw error;
    });
  }

  private roles(user?: JwtUser): string[] {
    return (user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  private requester(req: Req) {
    return { id: String(req.user.sub), roles: this.roles(req.user) };
  }

  private isPrivileged(user?: JwtUser): boolean {
    const roles = this.roles(user);
    return (
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN)
    );
  }

  private assertId(value: string, label = 'Ombor'): string {
    const id = String(value ?? '').trim();
    if (!ID_PATTERN.test(id)) {
      throw new NotFoundException(`${label} topilmadi`);
    }
    return id;
  }

  /**
   * Filial xodimi (MANAGER/BRANCH) — o'z filiali: branch-service
   * `branch.user.find_by_user` (manba), bo'lmasa tokendagi `branch_id`.
   * Aniqlanmasa — 403 (fail-closed). SUPERADMIN/ADMIN — `undefined`
   * (cheklovsiz).
   */
  async resolveScope(
    user: JwtUser,
  ): Promise<{ branch_id: string } | undefined> {
    if (this.isPrivileged(user)) return undefined;
    let branchId = '';
    try {
      const response = await firstValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: String(user.sub),
              requester: { id: String(user.sub), roles: this.roles(user) },
            },
          )
          .pipe(timeout(8000)),
      );
      const raw = (response as { data?: { branch_id?: unknown } } | null)?.data
        ?.branch_id;
      branchId =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw).trim()
          : '';
    } catch {
      branchId = '';
    }
    if (!branchId) {
      branchId = String(user.branch_id ?? '').trim();
    }
    if (!/^\d+$/.test(branchId)) {
      throw new ForbiddenException(
        "Siz hech qaysi filialga biriktirilmagansiz — ombor ma'lumotini ko'rib bo'lmaydi",
      );
    }
    return { branch_id: branchId };
  }

  /** Market operatori biriktirilgan market (identity `user.market_id`). */
  private async operatorMarketId(user: JwtUser): Promise<string> {
    const profile: unknown = await firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id: user.sub })
        .pipe(timeout(8000)),
    ).catch(() => null);
    const raw = (profile as { data?: { market_id?: unknown } } | null)?.data
      ?.market_id;
    const marketId =
      typeof raw === 'string' || typeof raw === 'number'
        ? String(raw).trim()
        : '';
    if (!marketId) {
      throw new BadRequestException(
        'Operator hech qaysi marketga biriktirilmagan',
      );
    }
    return marketId;
  }

  /**
   * Market tomoni: MARKET — token `sub` (boshqa `market_id` — 403),
   * MARKET_OPERATOR — biriktirilgan marketi. Xodim — `requested` (ixtiyoriy).
   */
  async resolveMarketId(
    user: JwtUser,
    requested?: string,
  ): Promise<{ marketId: string | undefined; marketSide: boolean }> {
    const roles = this.roles(user);
    const wanted = String(requested ?? '').trim() || undefined;
    const staff =
      this.isPrivileged(user) || roles.includes(RoleEnum.REGISTRATOR);
    if (!staff && roles.includes(RoleEnum.MARKET)) {
      const own = String(user.sub);
      if (wanted && wanted !== own) {
        throw new ForbiddenException(
          "Market faqat o'z mahsulotlari bilan ishlay oladi",
        );
      }
      return { marketId: own, marketSide: true };
    }
    if (!staff && roles.includes(RoleEnum.MARKET_OPERATOR)) {
      const own = await this.operatorMarketId(user);
      if (wanted && wanted !== own) {
        throw new ForbiddenException(
          'Operator faqat biriktirilgan market mahsulotlari bilan ishlay oladi',
        );
      }
      return { marketId: own, marketSide: true };
    }
    if (wanted && !ID_PATTERN.test(wanted)) {
      throw new BadRequestException("market_id noto'g'ri");
    }
    return { marketId: wanted, marketSide: false };
  }

  // ------------------------------------------------------------------
  // Buyurtma formasi (statik yo'llar — `:id` dan OLDIN)
  // ------------------------------------------------------------------

  @Post('warehouses/resolve-source')
  @HttpCode(200)
  @Roles(...WAREHOUSE_ORDER_ROLES)
  @ApiOperation({
    summary: 'Buyurtma manbasi: ombor yoki HQ (faqat hisoblaydi)',
    description:
      "Qaror 4: buyurtma tumani filialida FAOL ombor bo'lsa va HAMMA mahsulot yetarli bo'lsa — `source: WAREHOUSE`, aks holda butun buyurtma `HQ` (bo'linmaydi), `reason` va `shortages` bilan. Hech narsa band qilinmaydi — band order-service yaratishda (`catalog.warehouse.reserve`). MARKET/MARKET_OPERATOR — faqat o'z marketi; market kaliti «Ombordan buyurtma yaratish» o'chiq bo'lsa — `HQ` + `MARKET_NOT_ALLOWED`.",
  })
  @ApiBody({ type: WarehouseResolveSourceRequestDto })
  @ApiOkResponse({ type: WarehouseResolveSourceResponseDto })
  async resolveSource(
    @Body() dto: WarehouseResolveSourceRequestDto,
    @Req() req: Req,
  ) {
    const { marketId } = await this.resolveMarketId(req.user, dto.market_id);
    return this.send(WAREHOUSE_RPC.RESOLVE_SOURCE, {
      district_id: dto.district_id,
      region_id: dto.region_id,
      market_id: marketId,
      items: dto.items ?? [],
      requester: this.requester(req),
    });
  }

  @Get('warehouses/availability')
  @Roles(...WAREHOUSE_ORDER_ROLES)
  @ApiOperation({
    summary: '«Omborda: N» — hudud omboridagi mavjud dona (yaratish formasi)',
    description:
      "Tuman (yoki hudud) filialidagi birinchi FAOL ombor; `market_id` mahsulotlari yoki `product_ids` (vergul bilan, ≤500). Ombor to'xtatilgan bo'lsa — `warehouse.status = PAUSED`, `items: []`. MARKET/MARKET_OPERATOR — faqat o'z marketi.",
  })
  @ApiQuery({ name: 'district_id', required: false, type: String })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'product_ids',
    required: false,
    type: String,
    example: '142,143',
  })
  @ApiOkResponse({ type: WarehouseAvailabilityResponseDto })
  async availability(
    @Req() req: Req,
    @Query('district_id') districtId?: string,
    @Query('region_id') regionId?: string,
    @Query('market_id') requestedMarketId?: string,
    @Query('product_ids') productIds?: string,
  ) {
    const { marketId } = await this.resolveMarketId(
      req.user,
      requestedMarketId,
    );
    if (!marketId && !String(productIds ?? '').trim()) {
      throw new BadRequestException('market_id yoki product_ids majburiy');
    }
    return this.send(WAREHOUSE_RPC.AVAILABILITY, {
      district_id: districtId,
      region_id: regionId,
      market_id: marketId,
      product_ids: productIds,
      // Market tomoni: begona mahsulot id'lari bilan so'ralsa ham faqat o'z
      // marketi qatorlari qaytadi (`market_id` filtri).
    });
  }

  @Get('market/warehouse-stock')
  @Roles(...MARKET_STOCK_ROLES)
  @ApiOperation({
    summary:
      '«Ombordagi qoldiq» — market mahsulotlari omborlar kesimida (faqat ko‘rish)',
    description:
      "Market — FAQAT o'z mahsulotlari (token; boshqa `market_id` — 403); market operatori — biriktirilgan marketi; SUPERADMIN/ADMIN — `market_id` majburiy. Ustunlar — hamma omborlar (to'xtatilgani belgisi bilan); katakda MAVJUD dona (band ayirilgan); `total_available` — faqat faol omborlar.",
  })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'low_only',
    required: false,
    type: Boolean,
    description: '«Faqat kam qolganlar»',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiOkResponse({ type: MarketWarehouseStockResponseDto })
  async marketStock(
    @Req() req: Req,
    @Query('market_id') requestedMarketId?: string,
    @Query('search') search?: string,
    @Query('low_only') lowOnly?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { marketId } = await this.resolveMarketId(
      req.user,
      requestedMarketId,
    );
    if (!marketId) {
      throw new BadRequestException('market_id majburiy');
    }
    return this.send(WAREHOUSE_RPC.MARKET_STOCK, {
      market_id: marketId,
      query: { search, low_only: lowOnly, page, limit },
    });
  }

  @Patch('markets/:id/warehouse-order')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary:
      'Market «Ombordan buyurtma yaratish» kaliti (can_order_from_warehouse)',
    description:
      "Faqat SUPERADMIN/ADMIN (identity ham tekshiradi). Sukut — o'chiq. Xuddi shu maydon `PATCH /users/:id` (market tahrirlash formasi) orqali ham o'zgaradi.",
  })
  @ApiParam({ name: 'id', description: 'Market user ID' })
  @ApiBody({ type: UpdateMarketWarehouseOrderRequestDto })
  @ApiOkResponse({
    description: 'Market yangilandi (`data.can_order_from_warehouse`)',
  })
  updateMarketWarehouseOrder(
    @Param('id') id: string,
    @Body() dto: UpdateMarketWarehouseOrderRequestDto,
    @Req() req: Req,
  ) {
    const marketId = this.assertId(id, 'Market');
    return firstValueFrom(
      this.identityClient
        .send(
          { cmd: 'identity.market.update' },
          {
            id: marketId,
            dto: { can_order_from_warehouse: dto.can_order_from_warehouse },
            requester: this.requester(req),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

  // ------------------------------------------------------------------
  // Omborlar
  // ------------------------------------------------------------------

  @Get('warehouses')
  @Roles(...WAREHOUSE_READ_ROLES)
  @ApiOperation({
    summary: "Omborlar ro'yxati",
    description:
      "Har qatorda filial, viloyat, mas'ul xodim, jami/band/kam qolgan, oxirgi harakat, holat. `summary` — ko'rinadigan hamma omborlar (filtrsiz), `counts` — viloyat/qidiruvdan keyin holat bo'yicha. Filial menejeri — faqat o'z filiali ombori.",
  })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'PAUSED'] })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiOkResponse({ type: WarehouseListResponseDto })
  async findAll(
    @Req() req: Req,
    @Query('status') status?: string,
    @Query('region_id') regionId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = await this.resolveScope(req.user);
    return this.send(WAREHOUSE_RPC.FIND_ALL, {
      query: { status, region_id: regionId, search, page, limit },
      ...(scope ? { scope } : {}),
    });
  }

  @Post('warehouses')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Ombor ochish',
    description:
      "Faqat FAOL viloyat filialida (REGIONAL/HYBRID); bitta filial — bitta ombor (409). Nom berilmasa — «<filial> ombori». Mas'ul xodim — shu filial menejeri (aks holda 400). Yangi ombor — FAOL.",
  })
  @ApiBody({ type: CreateWarehouseRequestDto })
  @ApiCreatedResponse({ type: WarehouseDetailDto })
  create(@Body() dto: CreateWarehouseRequestDto, @Req() req: Req) {
    return this.send(WAREHOUSE_RPC.CREATE, {
      dto,
      requester: this.requester(req),
    });
  }

  @Get('warehouses/:id')
  @Roles(...WAREHOUSE_READ_ROLES)
  @ApiOperation({
    summary: 'Bitta ombor (sarlavha + KPI)',
    description:
      "Pozitsiyalar/marketlar, jami/mavjud, band (+ faol buyurtmalar soni), kam qoldi/tugagan, `movements_count`. Filial menejeri — faqat o'z filiali (begonasi 404).",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiOkResponse({ type: WarehouseDetailDto })
  async findOne(@Param('id') id: string, @Req() req: Req) {
    const scope = await this.resolveScope(req.user);
    return this.send(WAREHOUSE_RPC.FIND_BY_ID, {
      id: this.assertId(id),
      ...(scope ? { scope } : {}),
    });
  }

  @Patch('warehouses/:id')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: "Ombor ma'lumotlarini tahrirlash",
    description: "Filial o'zgarmaydi. `null` — maydonni tozalash.",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiBody({ type: UpdateWarehouseRequestDto })
  @ApiOkResponse({ type: WarehouseDetailDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWarehouseRequestDto,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.UPDATE, {
      id: this.assertId(id),
      dto,
      requester: this.requester(req),
    });
  }

  @Post('warehouses/:id/pause')
  @HttpCode(200)
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: "Omborni to'xtatish",
    description:
      "Qoldiq joyida saqlanadi va ko'rinadi, yangi buyurtma tushmaydi (manba — HQ). Mavjud bandlar ishlayveradi. Takror — `changed: false`.",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiBody({ type: WarehouseStatusRequestDto, required: false })
  @ApiOkResponse({ type: WarehouseDetailDto })
  pause(
    @Param('id') id: string,
    @Body() dto: WarehouseStatusRequestDto,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.PAUSE, {
      id: this.assertId(id),
      note: dto?.note,
      requester: this.requester(req),
    });
  }

  @Post('warehouses/:id/resume')
  @HttpCode(200)
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({ summary: 'Omborni qayta yoqish' })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiBody({ type: WarehouseStatusRequestDto, required: false })
  @ApiOkResponse({ type: WarehouseDetailDto })
  resume(
    @Param('id') id: string,
    @Body() dto: WarehouseStatusRequestDto,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.RESUME, {
      id: this.assertId(id),
      note: dto?.note,
      requester: this.requester(req),
    });
  }

  @Get('warehouses/:id/stock')
  @Roles(...WAREHOUSE_READ_ROLES)
  @ApiOperation({
    summary: 'Qoldiq jadvali',
    description:
      "Mahsulot, kod (zavod shtrix kodi yoki ELC-P), market, qoldiq/band/mavjud, chegara, «Hisob vazni», holat (`level`: ok — Yetarli, low — Kam qoldi, out — Tugagan). Saralash: qoldiq o'sishi bo'yicha. `facets` — holat soni va «Market:» filtri.",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'level',
    required: false,
    type: String,
    example: 'low,out',
    description: 'ok, low, out (vergul bilan)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Nom, ELC-P kodi yoki shtrix kod',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOkResponse({ type: WarehouseStockListResponseDto })
  async listStock(
    @Param('id') id: string,
    @Req() req: Req,
    @Query('market_id') marketId?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = await this.resolveScope(req.user);
    return this.send(WAREHOUSE_RPC.STOCK, {
      id: this.assertId(id),
      query: { market_id: marketId, level, search, page, limit },
      ...(scope ? { scope } : {}),
    });
  }

  @Get('warehouses/:id/movements')
  @Roles(...WAREHOUSE_READ_ROLES)
  @ApiOperation({
    summary: 'Harakatlar jurnali',
    description:
      'Kirim, band, chiqim, qaytish, tuzatish — eng yangisi tepada, sahifalash. `order_id` — «Buyurtma №…».',
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiQuery({
    name: 'type',
    required: false,
    type: String,
    example: 'IN,ADJUST',
    description: 'IN, ADJUST, RESERVE, RELEASE, OUT, RETURN (vergul bilan)',
  })
  @ApiQuery({ name: 'product_id', required: false, type: String })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'ref_type',
    required: false,
    enum: ['stock_in', 'inventory', 'order', 'move'],
  })
  @ApiQuery({
    name: 'ref_id',
    required: false,
    type: String,
    description: 'ref_type=order bilan — buyurtma id',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO sana (>=)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO sana (<)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOkResponse({ type: WarehouseMovementListResponseDto })
  async listMovements(
    @Param('id') id: string,
    @Req() req: Req,
    @Query('type') type?: string,
    @Query('product_id') productId?: string,
    @Query('market_id') marketId?: string,
    @Query('ref_type') refType?: string,
    @Query('ref_id') refId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const scope = await this.resolveScope(req.user);
    return this.send(WAREHOUSE_RPC.MOVEMENTS, {
      id: this.assertId(id),
      query: {
        type,
        product_id: productId,
        market_id: marketId,
        ref_type: refType,
        ref_id: refId,
        from,
        to,
        page,
        limit,
      },
      ...(scope ? { scope } : {}),
    });
  }

  @Get('warehouses/:id/lookup')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Skaner: kod → mahsulot + shu ombordagi qoldiq',
    description:
      "`ELC-P-…` yoki zavod shtrix kodi. Topilmasa `data: []` (404 emas): zavod kodi bo'lsa «Mahsulotga bog'lash» — `PATCH /product/:id { barcode }`, so'ng kirim. `stock: null` — omborda hali yo'q.",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiQuery({ name: 'code', required: true, type: String })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiOkResponse({ type: WarehouseLookupResponseDto })
  lookup(
    @Param('id') id: string,
    @Query('code') code?: string,
    @Query('market_id') marketId?: string,
  ) {
    if (!String(code ?? '').trim()) {
      throw new BadRequestException("code bo'sh bo'lishi mumkin emas");
    }
    return this.send(WAREHOUSE_RPC.LOOKUP, {
      id: this.assertId(id),
      query: { code, market_id: marketId },
    });
  }

  @Post('warehouses/:id/stock-in')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: "Kirim — mahsulotni omborga qo'shish",
    description:
      "Qaror 3: darhol qoldiqqa, filial tasdig'isiz (to'xtatilgan omborga ham). Qatorlar `product_id` yoki skaner `code` bilan; biror qator hal qilinmasa — 400, hech narsa yozilmaydi. `Idempotency-Key` MAJBURIY: AYNI kalit + AYNI tarkib — avvalgi natija (`replayed: true`), boshqa tarkib — 409.",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8–128 belgi [A-Za-z0-9._:-], har yangi kirimga yangi (UUID)',
  })
  @ApiBody({ type: WarehouseStockInRequestDto })
  @ApiCreatedResponse({ type: WarehouseStockInResponseDto })
  stockIn(
    @Param('id') id: string,
    @Body() dto: WarehouseStockInRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.STOCK_IN, {
      warehouse_id: this.assertId(id),
      lines: dto.lines,
      market_id: dto.market_id,
      note: dto.note,
      idempotency_key: idempotencyKey,
      actor: this.requester(req),
    });
  }

  @Post('warehouses/:id/inventory')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: 'Inventarizatsiya — haqiqiy sonni kiritib farqni tuzatish',
    description:
      "Har qatorda `counted` — sanalgan dona; farq ADJUST bo'lib yoziladi (sabab majburiy). Band qilingandan kam — 409. Farq 0 — yozilmaydi. `Idempotency-Key` majburiy (takror — `replayed: true`, qayta qo'llanmaydi).",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: WarehouseInventoryRequestDto })
  @ApiCreatedResponse({ type: WarehouseInventoryResponseDto })
  inventory(
    @Param('id') id: string,
    @Body() dto: WarehouseInventoryRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.INVENTORY, {
      warehouse_id: this.assertId(id),
      lines: dto.lines,
      reason: dto.reason,
      market_id: dto.market_id,
      idempotency_key: idempotencyKey,
      actor: this.requester(req),
    });
  }

  @Patch('warehouses/:id/stock/:productId')
  @Roles(...WAREHOUSE_ADMIN_ROLES)
  @ApiOperation({
    summary: '«Kam qoldiq» chegarasi (mahsulot bo‘yicha)',
    description: '`null` — ombor sukuti (`low_stock_default`).',
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiParam({ name: 'productId', description: 'Product ID' })
  @ApiBody({ type: WarehouseThresholdRequestDto })
  @ApiOkResponse({ type: WarehouseThresholdResponseDto })
  setThreshold(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: WarehouseThresholdRequestDto,
    @Req() req: Req,
  ) {
    return this.send(WAREHOUSE_RPC.SET_THRESHOLD, {
      warehouse_id: this.assertId(id),
      product_id: this.assertId(productId, 'Mahsulot'),
      low_stock_threshold: dto.low_stock_threshold,
      actor: this.requester(req),
    });
  }

  @Get('warehouses/:id/export')
  @Roles(...WAREHOUSE_READ_ROLES)
  @ApiOperation({
    summary: 'Qoldiqni Excel (.xlsx) ga yuklash',
    description:
      "«Excelga yuklash»: shu ombor qoldig'i (filtrlar `stock` bilan bir xil, sahifasiz, ≤10 000 qator).",
  })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'level', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  async exportStock(
    @Param('id') id: string,
    @Req() req: Req,
    @Res() res: Response,
    @Query('market_id') marketId?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
  ): Promise<void> {
    const warehouseId = this.assertId(id);
    const scope = await this.resolveScope(req.user);
    const result = await this.send<{
      warehouse?: { name?: string };
      data?: Array<Record<string, any>>;
    }>(WAREHOUSE_RPC.STOCK, {
      id: warehouseId,
      query: { market_id: marketId, level, search, all: true },
      ...(scope ? { scope } : {}),
    });
    const rows = (result?.data ?? []).map((row) => ({
      product: row.product?.name ?? '',
      code: row.product?.code?.value ?? '',
      code_kind:
        row.product?.code?.kind === 'barcode'
          ? `Zavod shtrix kodi (${row.product?.code?.format ?? ''})`
          : 'Elchi QR kodi',
      market: row.market?.name ?? row.market?.id ?? '',
      on_hand: row.on_hand ?? 0,
      reserved: row.reserved ?? 0,
      available: row.available ?? 0,
      threshold: row.threshold ?? 0,
      level: LEVEL_LABEL[String(row.level)] ?? String(row.level ?? ''),
      weight:
        row.product?.chargeable_weight_kg === null ||
        row.product?.chargeable_weight_kg === undefined
          ? ''
          : row.product.chargeable_weight_kg,
      basis:
        row.product?.chargeable_basis === 'volumetric' ? "hajm bo'yicha" : '',
      last_movement_at: excelDate(row.last_movement_at),
    }));
    const buffer = await buildXlsx(
      'Qoldiq',
      [
        { header: 'Mahsulot', key: 'product', width: 32 },
        { header: 'Kod', key: 'code', width: 20 },
        { header: 'Kod turi', key: 'code_kind', width: 26 },
        { header: 'Market', key: 'market', width: 22 },
        { header: 'Qoldiq', key: 'on_hand', width: 10 },
        { header: 'Band', key: 'reserved', width: 10 },
        { header: 'Mavjud', key: 'available', width: 10 },
        { header: 'Chegara', key: 'threshold', width: 10 },
        { header: 'Holat', key: 'level', width: 12 },
        { header: 'Hisob vazni, kg', key: 'weight', width: 14 },
        { header: 'Hisob asosi', key: 'basis', width: 14 },
        { header: 'Oxirgi harakat', key: 'last_movement_at', width: 22 },
      ],
      rows,
    );
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="ombor-${warehouseId}-qoldiq.xlsx"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }
}
