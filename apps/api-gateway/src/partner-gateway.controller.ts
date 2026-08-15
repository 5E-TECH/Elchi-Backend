import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PartnerApiKeyGuard,
  PartnerPrincipal,
} from './auth/partner-api-key.guard';
import { PartnerThrottlerGuard } from './auth/partner-throttler.guard';
import { Public } from './auth/public.decorator';
import { CreatePartnerMarketRequestDto } from './dto/partner-market.swagger.dto';
import { CreatePartnerShipmentRequestDto } from './dto/partner-shipment.swagger.dto';

/**
 * Elchi Partner API HTTP kirish nuqtasi (`/partner/*`).
 *
 * JWT EMAS — PartnerApiKeyGuard (`X-Api-Key`) bilan himoyalanadi va
 * PartnerThrottlerGuard bilan per-hamkor rate limit qo'llanadi.
 * C1.2: auth+limit+ping. C1.4: geo passthrough (regions/districts/tariff) —
 * ichkarida mavjud `logistics.*` / `identity.market.*` patternlari.
 * markets/shipments keyingi tasklarda (C1.5+, C2). Kontrakt: docs/PARTNER_API.md.
 */

// Per-hamkor rate limit (ENV bilan sozlanadi). Global IP-limitdan ustun.
export const PARTNER_THROTTLE_LIMIT = Number(
  process.env.PARTNER_THROTTLE_LIMIT ?? 120,
);
export const PARTNER_THROTTLE_TTL_MS = Number(
  process.env.PARTNER_THROTTLE_TTL_MS ?? 60_000,
);
const PARTNER_THROTTLE = {
  default: { limit: PARTNER_THROTTLE_LIMIT, ttl: PARTNER_THROTTLE_TTL_MS },
};

// A partner shipment create orchestrates customer.create + order.create (which
// itself runs the COD/settlement setup) sequentially, so it can exceed the 8s
// standard tier. An 8s cap here risks returning a timeout to the partner while
// the order is still being created → a retry would create a DUPLICATE shipment
// for the same external_order_id before the idempotency ref is persisted. Give
// it the provider-tier ceiling instead.
const PARTNER_SHIPMENT_TIMEOUT_MS = 65_000;

@ApiTags('Partner')
@ApiHeader({
  name: 'X-Api-Key',
  description: 'Hamkor API kaliti (JWT emas)',
  required: true,
})
@Throttle(PARTNER_THROTTLE)
@UseGuards(PartnerApiKeyGuard, PartnerThrottlerGuard)
@Public()
@Controller('partner')
export class PartnerGatewayController {
  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  /**
   * Kalit tekshiruvi (auth sanity-check). Yaroqli kalitda hamkor ma'lumotini
   * qaytaradi — integratsiya klienti ulanishni shu bilan tekshiradi.
   */
  @Get('ping')
  @ApiOperation({ summary: 'Partner API kalitini tekshirish (ping)' })
  @ApiOkResponse({ description: 'Kalit yaroqli — hamkor ma‘lumoti qaytadi' })
  @ApiUnauthorizedResponse({ description: 'X-Api-Key yo‘q yoki yaroqsiz' })
  @ApiTooManyRequestsResponse({ description: 'Rate limitdan oshdi' })
  ping(@Req() request: { partner: PartnerPrincipal }) {
    return { authenticated: true, partner: request.partner };
  }

  /** Elchi viloyatlari — manzilni Elchi region_id'ga moslash uchun. */
  @Get('regions')
  @ApiOperation({ summary: 'Elchi viloyatlari ro‘yxati' })
  @ApiOkResponse({ description: '[{ id, name }]' })
  async getRegions(): Promise<Array<{ id: string; name: string }>> {
    const res = await firstValueFrom(
      this.logisticsClient.send<{
        data?: Array<{ id: string | number; name: string }>;
      }>({ cmd: 'logistics.region.find_all' }, {}).pipe(timeout(8000)),
    );
    return (res?.data ?? []).map((r) => ({ id: String(r.id), name: r.name }));
  }

  /** Elchi tumanlari — `region_id` bo‘yicha filtrlab. */
  @Get('districts')
  @ApiOperation({ summary: 'Elchi tumanlari (region_id bo‘yicha)' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiOkResponse({ description: '[{ id, name, region_id }]' })
  async getDistricts(
    @Query('region_id') regionId?: string,
  ): Promise<Array<{ id: string; name: string; region_id: string }>> {
    const res = await firstValueFrom(
      this.logisticsClient.send<{
        data?: Array<{
          id: string | number;
          name: string;
          region_id: string | number;
        }>;
      }>({ cmd: 'logistics.district.find_all' }, { region_id: regionId }).pipe(timeout(8000)),
    );
    return (res?.data ?? []).map((d) => ({
      id: String(d.id),
      name: d.name,
      region_id: String(d.region_id),
    }));
  }

  /**
   * Yetkazish tarifi (narx preview). Elchi tarifni SOTUVCHI-MARKET bo‘yicha
   * belgilaydi (region/district faqat yo‘nalish uchun) — shu bois tarif
   * `elchi_market_id` bilan olinadi. `where_deliver`: center → markazga tarif,
   * address → uyga tarif.
   */
  @Get('tariff')
  @ApiOperation({ summary: 'Yetkazish tarifi (market bo‘yicha, narx preview)' })
  @ApiQuery({ name: 'elchi_market_id', required: true, type: String })
  @ApiQuery({
    name: 'where_deliver',
    required: false,
    enum: ['center', 'address'],
  })
  @ApiOkResponse({
    description: '{ elchi_market_id, where_deliver, market_tariff }',
  })
  @ApiNotFoundResponse({ description: 'Market topilmadi' })
  async getTariff(
    @Query('elchi_market_id') elchiMarketId?: string,
    @Query('where_deliver') whereDeliver?: string,
  ): Promise<{
    elchi_market_id: string;
    where_deliver: string;
    market_tariff: number;
  }> {
    if (!elchiMarketId?.trim()) {
      throw new BadRequestException('elchi_market_id majburiy');
    }
    const mode = whereDeliver === 'center' ? 'center' : 'address';
    const res = await firstValueFrom(
      this.identityClient.send<{
        data?: Array<{
          id: string | number;
          tariff_home?: number;
          tariff_center?: number;
        }>;
      }>({ cmd: 'identity.market.find_by_ids' }, { ids: [elchiMarketId] }).pipe(timeout(8000)),
    );
    const market = (res?.data ?? [])[0];
    if (!market) {
      throw new NotFoundException('Market topilmadi');
    }
    const tariff =
      mode === 'center'
        ? (market.tariff_center ?? 0)
        : (market.tariff_home ?? 0);
    return {
      elchi_market_id: String(elchiMarketId),
      where_deliver: mode,
      market_tariff: Number(tariff),
    };
  }

  /**
   * Sotuvchi uchun Elchi market provisioning (idempotent). Integration-service
   * market + cashbox ochadi va hamkorга bog'laydi; javobda `elchi_market_id`.
   * Bir xil `external_seller_id` bilan qayta chaqirilsa yangi market ochilmaydi.
   */
  @Post('markets')
  @ApiOperation({ summary: 'Sotuvchi uchun Elchi market ochish (idempotent)' })
  @ApiBody({ type: CreatePartnerMarketRequestDto })
  @ApiCreatedResponse({ description: '{ elchi_market_id }' })
  provisionMarket(
    @Req() request: { partner: PartnerPrincipal },
    @Body() dto: CreatePartnerMarketRequestDto,
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.provision_market' },
        {
          ...dto,
          partner_id: request.partner.id,
          requester: { id: `partner:${request.partner.id}` },
        },
      ).pipe(timeout(8000)),
    );
  }

  /**
   * Buyurtmani Elchi'ga posilka (shipment) sifatida uzatish → Elchi order.create.
   * Idempotent (external_order_id). cod_amount=0 → prepaid; >0 → COD.
   */
  @Post('shipments')
  @ApiOperation({ summary: 'Shipment yaratish (order.create), idempotent' })
  @ApiBody({ type: CreatePartnerShipmentRequestDto })
  @ApiCreatedResponse({
    description: '{ shipment_id, order_status, qr_code_token, to_be_paid }',
  })
  provisionShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Body() dto: CreatePartnerShipmentRequestDto,
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.create_shipment' },
        { ...dto, partner_id: request.partner.id },
      ).pipe(timeout(PARTNER_SHIPMENT_TIMEOUT_MS)),
    );
  }

  /**
   * Posilka holatini ko'rish (status / tracking / cod). `:id` = shipment_id
   * (C2.1 javobidagi qiymat). Faqat hamkorning o'z posilkasi ko'rinadi.
   */
  @Get('shipments/:id')
  @ApiOperation({ summary: 'Shipment holati (status/tracking/cod)' })
  @ApiOkResponse({
    description:
      '{ shipment_id, external_order_id, status, cod_amount, tracking }',
  })
  @ApiNotFoundResponse({ description: 'Shipment topilmadi' })
  getShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Param('id') id: string,
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.get_shipment' },
        { shipment_id: id, partner_id: request.partner.id },
      ).pipe(timeout(8000)),
    );
  }

  /**
   * Posilkani bekor qilish. Yetkazib bo'lingan posilkani bekor qilib bo'lmaydi
   * (409). Faqat hamkorning o'z posilkasi.
   */
  @Post('shipments/:id/cancel')
  @ApiOperation({ summary: 'Shipment bekor qilish (yetkazilgan → 409)' })
  @ApiOkResponse({ description: '{ shipment_id, status: "cancelled" }' })
  @ApiNotFoundResponse({ description: 'Shipment topilmadi' })
  cancelShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Param('id') id: string,
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.cancel_shipment' },
        { shipment_id: id, partner_id: request.partner.id },
      ).pipe(timeout(10000)),
    );
  }
}
