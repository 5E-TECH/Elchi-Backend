import {
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateDeliveryTariffRequestDto,
  DeliveryPricingSettingsResponseDto,
  DeliveryQuoteRequestDto,
  DeliveryQuoteByTariffRequestDto,
  DeliveryQuoteResponseDto,
  DeliveryTariffRowDto,
  DeliveryTariffsListResponseDto,
  UpdateDeliveryPricingSettingsRequestDto,
} from './dto/delivery-pricing.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
}

/**
 * Narxni ko'ra oladigan rollar: buyurtma yaratuvchi xodimlar + MARKET
 * (o'z mahsulotlari bilan — egalik logistics-service'da tekshiriladi).
 * MARKET_OPERATOR, COURIER, CUSTOMER, INVESTOR — yo'q.
 */
export const DELIVERY_QUOTE_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.REGISTRATOR,
  RoleEnum.OPERATOR,
  RoleEnum.LOGIST,
  RoleEnum.BRANCH,
  RoleEnum.MARKET,
] as const;

/** Tarif va formula sozlamalarini faqat shular ko'radi va o'zgartiradi. */
export const DELIVERY_PRICING_ADMIN_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
] as const;

const LOGISTICS_TIMEOUT_MS = 8000;

/**
 * DAqXPeSy — yetkazish narxi dvigateli (HTTP → logistics-service RMQ).
 *
 * `POST /delivery/quote` FAQAT hisoblaydi — hech narsa yozmaydi; buyurtma
 * DTO'siga narx maydoni qo'shilmaydi (sotuvda qotirish — KmWO9gTA).
 * Admin yozuvlari (`POST /delivery/tariffs`, `PATCH /delivery/pricing-settings`)
 * yangi VERSIYA yaratadi va activity-log'ga tushadi (logistics-service).
 */
@ApiTags('Delivery pricing')
@ApiExtraModels(DeliveryTariffRowDto)
@Controller('delivery')
export class DeliveryPricingGatewayController {
  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
  ) {}

  private send(cmd: string, payload: object) {
    return firstValueFrom(
      this.logisticsClient
        .send({ cmd }, payload)
        .pipe(timeout(LOGISTICS_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Logistics service response timeout');
      }
      throw error;
    });
  }

  private requester(req: { user: JwtUser }) {
    return { id: String(req.user.sub), roles: req.user.roles ?? [] };
  }

  @Post('quote')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_QUOTE_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Yetkazish narxini hisoblash (taxminiy; hech narsa yozilmaydi)',
    description:
      'DAqXPeSy. Tarif: ikkala uchi ham `regions.is_city_zone` (Toshkent shahri) → `city`, aks holda `where_deliver` (`center`/`address`). ' +
      "Elementlar BITTA jo'natma: og'irliklar va hajmlar qo'shiladi (× quantity), baza bir marta. `product_id` — o'lchov catalog'dan (MARKET — faqat o'z mahsuloti, begonasi 404). " +
      "O'lchovsiz element jimgina 0 bermaydi: `unmeasuredItems` / `missingDimensionItems` > 0 va `estimated: true`. " +
      '`total` — 500 ga karrali YOZILADIGAN narx (pickup kirmaydi); `totalWithPickup` — kalkulyator jami. ' +
      "Xatolar: 400 (validatsiya, tuman–viloyat mos emas), 404 (viloyat/tuman/mahsulot), 409 (faol tarif yoki sozlama yo'q), 503 (catalog javob bermadi).",
  })
  @ApiBody({ type: DeliveryQuoteRequestDto })
  @ApiOkResponse({ type: DeliveryQuoteResponseDto })
  quote(@Body() dto: DeliveryQuoteRequestDto, @Req() req: { user: JwtUser }) {
    return this.send('logistics.delivery.quote', {
      ...dto,
      requester: this.requester(req),
    });
  }

  @Post('quote/by-tariff')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_QUOTE_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Uchala tarif bo'yicha taxminiy yetkazish narxi (hududsiz; hech narsa yozilmaydi)",
    description:
      "6FLyjO6j (mahsulot formasi). Javob: `quotes.city` / `quotes.center` / `quotes.address` — har biri `POST /delivery/quote` natijasi shaklida (faol versiyasi yo'q tarif — `null`). " +
      "Elementlar `POST /delivery/quote` dagi kabi; MARKET — faqat o'z mahsuloti (begonasi 404). Xatolar: 400, 404, 409 (sozlama yo'q), 503.",
  })
  @ApiBody({ type: DeliveryQuoteByTariffRequestDto })
  quoteByTariff(
    @Body() dto: DeliveryQuoteByTariffRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('logistics.delivery.quote_by_tariff', {
      ...dto,
      requester: this.requester(req),
    });
  }

  @Get('tariffs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_PRICING_ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Yetkazish tariflari: hozirgi versiyalar + tarix (admin)',
    description:
      "`data.current` — `{ city, center, address }` hozir amaldagi versiya (`valid_from <= now()`, eng so'nggisi). " +
      '`data.versions` — barcha versiyalar, yangisi tepada (`is_current`, `is_scheduled` — kelajakda kuchga kiradigan).',
  })
  @ApiQuery({
    name: 'tariff_id',
    required: false,
    enum: ['city', 'center', 'address'],
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Tarix qatorlari (sukut 100, ko`pi bilan 500)',
  })
  @ApiOkResponse({ type: DeliveryTariffsListResponseDto })
  listTariffs(
    @Query('tariff_id') tariffId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.send('logistics.delivery.tariffs.find_all', {
      ...(tariffId ? { tariff_id: tariffId } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Post('tariffs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_PRICING_ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Yangi tarif versiyasi (admin; eski versiya o`chirilmaydi)',
    description:
      "Narx o'zgarishi — YANGI qator, `valid_from` dan kuchga kiradi (berilmasa — hozir; kelajak — rejalashtirilgan; o'tmish — 400). " +
      "Amal activity-log'ga yoziladi (`logistics.delivery_tariff_created`).",
  })
  @ApiBody({ type: CreateDeliveryTariffRequestDto })
  @ApiCreatedResponse({ description: 'Yangi versiya yaratildi' })
  createTariff(
    @Body() dto: CreateDeliveryTariffRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('logistics.delivery.tariffs.create', {
      dto,
      requester: this.requester(req),
    });
  }

  @Get('pricing-settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_PRICING_ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Narx formulasi sozlamalari (faol versiya, admin)' })
  @ApiOkResponse({ type: DeliveryPricingSettingsResponseDto })
  getSettings() {
    return this.send('logistics.delivery.settings.get', {});
  }

  @Patch('pricing-settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DELIVERY_PRICING_ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Narx formulasi sozlamalarini o`zgartirish (admin; yangi versiya)',
    description:
      "Qisman: faqat yuborilgan maydonlar o'zgaradi. Yangi faol qator yoziladi, eskisi `is_active=false` (tarix qoladi); hech narsa o'zgarmasa versiya ham, jurnal ham yo'q. " +
      "Amal activity-log'ga yoziladi (`logistics.delivery_pricing_settings_updated`, eski/yangi qiymat bilan).",
  })
  @ApiBody({ type: UpdateDeliveryPricingSettingsRequestDto })
  @ApiOkResponse({ type: DeliveryPricingSettingsResponseDto })
  updateSettings(
    @Body() dto: UpdateDeliveryPricingSettingsRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.send('logistics.delivery.settings.update', {
      dto,
      requester: this.requester(req),
    });
  }
}
