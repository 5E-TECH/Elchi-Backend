import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  isSalePricingEngineActive,
  readSalePricingConfig,
  resolveOrderTariffDetailed,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import {
  ApiBody,
  ApiConflictResponse,
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
import {
  CreatePartnerShipmentRequestDto,
  PartnerShipmentsStatusRequestDto,
  UpdatePartnerShipmentRequestDto,
} from './dto/partner-shipment.swagger.dto';
import {
  buildPartnerQuotePayload,
  parsePartnerTariffQuery,
  PARTNER_TARIFF_WEIGHT_KG_MAX,
  type PartnerTariffPayload,
  toPartnerEngineQuote,
  toPartnerQuote,
} from './partner-tariff';
import type { PartnerTariffQuery } from './partner-tariff';

/**
 * Elchi Partner API HTTP kirish nuqtasi (`/partner/*`).
 *
 * JWT EMAS — PartnerApiKeyGuard (`X-Api-Key`) bilan himoyalanadi va
 * PartnerThrottlerGuard bilan per-hamkor rate limit qo'llanadi.
 * C1.2: auth+limit+ping. C1.4: geo passthrough (regions/districts/tariff) —
 * ichkarida mavjud `logistics.*` / `identity.market.*` patternlari.
 * markets/shipments keyingi tasklarda (C1.5+, C2). Kontrakt: docs/public/MARKETPLACE_API.md.
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

/**
 * HTTP KODINI TANADAGI `statusCode` BILAN MOSLASHTIRISH.
 *
 * ⚠️ NIMA BUZILGAN EDI (lokal sinovda topildi). NestJS `@Post` uchun sukut
 * bo'yicha HTTP 201 qaytaradi. Servis esa tanada aniq kod beradi:
 *
 *   yangi posilka          -> 201 (to'g'ri)
 *   idempotent takror      -> tana 200, HTTP esa 201  ← nomuvofiq
 *   bekor qilish           -> tana 200, HTTP esa 201  ← hech narsa yaratilmadi
 *   allaqachon bekor       -> tana 200, HTTP esa 201  ← nomuvofiq
 *
 * Marketplace HTTP KODIGA qaraydi — ularning HTTP mijozi shuni ko'radi.
 * Har bir POST 201 qaytarsa, "yaratildi" va "allaqachon bor" ni HTTP
 * darajasida ajratib bo'lmaydi va hujjatdagi kod jadvali yolg'on bo'ladi.
 *
 * Qoida ODDIY va hujjatlashtiriladi: HTTP kodi HAR DOIM tanadagi
 * `statusCode` ga teng.
 *
 * ⚠️ PCS (BeePost) uchun xavfsiz: u HTTP kodini faqat XATO uchun ishlatadi
 * (axios >=400 da otadi), 200/201 ikkisi ham muvaffaqiyat deb o'qiladi.
 */
const syncHttpStatus = (
  res: { status?: (code: number) => unknown } | undefined,
  body: unknown,
): unknown => {
  const code = Number((body as { statusCode?: unknown } | null)?.statusCode);
  /**
   * `res?.status` — himoyalangan chaqiruv. Ishlab chiqarishda Nest `res` ni
   * har doim inject qiladi; u YO'Q bo'lishi faqat kontroller metodi to'g'ridan
   * to'g'ri chaqirilganda (unit test) yuz beradi. Himoyasiz bo'lsa test
   * yiqilardi, kod esa to'g'ri.
   */
  if (Number.isInteger(code) && code >= 200 && code < 300) {
    res?.status?.(code);
  }
  return body;
};

/**
 * Partner API javob qobig'i.
 *
 * BARCHA `/partner/*` javobi shu shaklda (2026-09-12 dan). Ilgari geo va
 * ping marshrutlari XOM qaytarardi, shipments/markets esa qobiqli — ya'ni
 * bitta API ikki xil shaklda gaplashardi va tashqi dasturchi har endpoint
 * uchun alohida o'qish mantiqini yozishi kerak edi.
 */
type PartnerEnvelope<T> = {
  statusCode: number;
  message: string;
  data: T;
};

/**
 * Market SHU hamkor tomonidan ochilganmi (fix3 RBAC-13).
 *
 * `partner_market_refs` qatori FAQAT `integration.partner.provision_market`
 * da yoziladi va u marketni har doim `mp<partner_id>_<external_seller_id>`
 * (kichik harf) username bilan ochadi (`buildMarketUsername`). Market
 * username'ini keyin o'zgartirib bo'lmaydi (UpdateMarketDto'da yo'q) — shu
 * sababli prefiks egalikning ishonchli belgisi. Ilgari `GET /partner/tariff`
 * istalgan Elchi marketining tarifini istalgan hamkorga qaytarardi.
 * Hamkor aniqlanmasa — false (fail-closed).
 */
export function isPartnerProvisionedMarket(
  market: { username?: string | null } | null | undefined,
  partnerId: string | number | null | undefined,
): boolean {
  const id = String(partnerId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    return false;
  }
  const username = String(market?.username ?? '')
    .trim()
    .toLowerCase();
  return username.startsWith(`mp${id}_`);
}

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
  private readonly logger = new Logger(PartnerGatewayController.name);

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
  @ApiOkResponse({
    description: '{ statusCode, message, data: { authenticated, partner } }',
  })
  @ApiUnauthorizedResponse({ description: 'X-Api-Key yo‘q yoki yaroqsiz' })
  @ApiTooManyRequestsResponse({ description: 'Rate limitdan oshdi' })
  ping(@Req() request: { partner: PartnerPrincipal }) {
    /**
     * ⚠️ QOBIQ BIRXILLASHTIRILDI (2026-09-12).
     *
     * Ilgari bu marshrut XOM javob qaytarardi (`{authenticated, partner}`),
     * `POST /partner/shipments` esa `{statusCode, message, data}` qobig'ida.
     * Ya'ni bitta API ikki xil shaklda gaplashardi va tashqi dasturchi
     * har bir endpoint uchun alohida o'qish mantiqini yozishi kerak edi.
     *
     * Endi HAMMA `/partner/*` javobi bitta shaklda.
     */
    return successRes(
      { authenticated: true, partner: request.partner },
      200,
      'authenticated',
    );
  }

  /**
   * Elchi viloyatlari — manzilni Elchi region_id'ga moslash uchun.
   *
   * `sato_code` (SOATO klassifikatori) ATAYLAB qaytariladi: hamkor tizimlar ham
   * SOATO bilan ishlaydi, shuning uchun bu kod ikki tomon orasidagi TABIIY KALIT
   * bo'lib xizmat qiladi — hamkor o'z hududlarini Elchi id'lariga QO'LDA emas,
   * avtomatik moslashtiradi. Busiz har hamkor 200+ tumanni qo'lda moslashi kerak.
   */
  @Get('regions')
  @ApiOperation({ summary: 'Elchi viloyatlari ro‘yxati' })
  @ApiOkResponse({
    description: '{ statusCode, message, data: [{ id, name, sato_code }] }',
  })
  async getRegions(): Promise<
    PartnerEnvelope<
      Array<{ id: string; name: string; sato_code: string | null }>
    >
  > {
    const res = await firstValueFrom(
      this.logisticsClient
        .send<{
          data?: Array<{
            id: string | number;
            name: string;
            sato_code?: string | null;
          }>;
        }>({ cmd: 'logistics.region.find_all' }, {})
        .pipe(timeout(8000)),
    );
    // Qobiq birxil (ping izohiga qara).
    return successRes(
      (res?.data ?? []).map((r) => ({
        id: String(r.id),
        name: r.name,
        sato_code: r.sato_code ?? null,
      })),
      200,
      'regions',
    );
  }

  /**
   * Elchi tumanlari — `region_id` bo‘yicha filtrlab.
   *
   * `sato_code` qaytariladi (yuqoridagi `getRegions` bilan bir xil sabab):
   * hamkor o'z tumanini SOATO bo'yicha Elchi `district_id`'siga avtomatik
   * moslashtiradi. `sato_code` null bo'lishi mumkin (Elchi'da tuman uchun kod
   * kiritilmagan) — bunda hamkor uni qo'lda moslashi kerak.
   */
  @Get('districts')
  @ApiOperation({ summary: 'Elchi tumanlari (region_id bo‘yicha)' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: [{ id, name, region_id, sato_code }] }',
  })
  async getDistricts(@Query('region_id') regionId?: string): Promise<
    PartnerEnvelope<
      Array<{
        id: string;
        name: string;
        region_id: string;
        sato_code: string | null;
      }>
    >
  > {
    const res = await firstValueFrom(
      this.logisticsClient
        .send<{
          data?: Array<{
            id: string | number;
            name: string;
            region_id: string | number;
            sato_code?: string | null;
          }>;
        }>({ cmd: 'logistics.district.find_all' }, { region_id: regionId })
        .pipe(timeout(8000)),
    );
    return successRes(
      (res?.data ?? []).map((d) => ({
        id: String(d.id),
        name: d.name,
        region_id: String(d.region_id),
        sato_code: d.sato_code ?? null,
      })),
      200,
      'districts',
    );
  }

  /**
   * Yetkazish tarifi (narx preview). Elchi tarifni SOTUVCHI-MARKET bo‘yicha
   * belgilaydi — shu bois tarif `elchi_market_id` bilan olinadi.
   * `where_deliver`: center → markazga tarif, address → uyga tarif.
   *
   * 6tGZzupr — dvigatelga ulandi, mustaqil tarif tanlovi olib tashlandi:
   *   - `market_tariff` — ELCHI SOTUVDA OLADIGAN summa
   *     (`resolveOrderTariffDetailed`, sotuv bilan yagona manba; kalitlar ham
   *     AYNI). `SALE_PRICING_ENGINE` o'chiq (sukut) — profil tarifi, prod narxi
   *     o'zgarmaydi. Sotuvchi hali noma'lum — floor faqat `min_delivery_price`
   *     (`saleMarketPaidMaxOf` qoidasi);
   *   - `quote` — dvigatel hisobi: o'lchov/express/pickup berilsa, kalit
   *     o'chiq bo'lsa ham; `logistics.delivery.sale_quote` — sotuvdagi AYNI
   *     hisob (`quote` emas: u market hududi yo'q bo'lsa 400 berardi);
   *   - o'lchov yo'q — `estimated: true` va baza tarif. Profilda tarif NULL —
   *     jadval bazasi (jimgina 0 emas), u ham yo'q — 503. Profilda aniq 0
   *     (hamkor tarif bermagan market, §5.1) — sotuvda ham 0, shuning uchun 0
   *     qoladi, yonida `quote` qaytadi;
   *   - yangi parametrsiz eski so'rov va tarifi bor market — logistics'ga
   *     BORILMAYDI; dvigatel javob bermasa sotuvdagidek profil tarifi.
   *
   * Noma'lum query'lar avvalgidek e'tiborsiz (DTO emas: `forbidNonWhitelisted`
   * eski hamkorni 400 ga tushirardi).
   */
  @Get('tariff')
  @ApiOperation({
    summary: 'Yetkazish tarifi (market bo‘yicha, narx preview)',
    description:
      "`market_tariff` — Elchi sotuvda oladigan summa. O'lchov berilsa `quote` da dvigatel hisobi; o'lchovsiz — `estimated: true` va baza tarif (jimgina 0 emas).",
  })
  @ApiQuery({ name: 'elchi_market_id', required: true, type: String })
  @ApiQuery({
    name: 'where_deliver',
    required: false,
    enum: ['center', 'address'],
  })
  @ApiQuery({
    name: 'weight_kg',
    required: false,
    type: Number,
    description: `Jami og'irlik, kg (ko'pi bilan 3 kasr, ${PARTNER_TARIFF_WEIGHT_KG_MAX} gacha)`,
  })
  @ApiQuery({
    name: 'length_cm',
    required: false,
    type: Number,
    description: 'Uzunlik, sm — L/W/H uchalasi birga',
  })
  @ApiQuery({
    name: 'width_cm',
    required: false,
    type: Number,
    description: 'Kenglik, sm — L/W/H uchalasi birga',
  })
  @ApiQuery({
    name: 'height_cm',
    required: false,
    type: Number,
    description: 'Balandlik, sm — L/W/H uchalasi birga',
  })
  @ApiQuery({ name: 'express', required: false, type: Boolean })
  @ApiQuery({ name: 'pickup', required: false, type: Boolean })
  @ApiQuery({
    name: 'region_id',
    required: false,
    type: String,
    description: 'Qabul qiluvchi viloyati (yo‘nalish tarifi uchun)',
  })
  @ApiQuery({
    name: 'district_id',
    required: false,
    type: String,
    description: 'Qabul qiluvchi tumani (yo‘nalish tarifi uchun)',
  })
  @ApiOkResponse({
    description:
      '{ statusCode, message, data: { elchi_market_id, where_deliver, market_tariff, tariff_source, estimated, quote } }',
  })
  @ApiNotFoundResponse({
    description: 'Market topilmadi yoki shu hamkorga tegishli emas',
  })
  async getTariff(
    @Query('elchi_market_id') elchiMarketId?: string,
    @Query('where_deliver') whereDeliver?: string,
    @Req() request?: { partner?: PartnerPrincipal },
    @Query() query?: PartnerTariffQuery,
  ): Promise<PartnerEnvelope<PartnerTariffPayload>> {
    if (!elchiMarketId?.trim()) {
      throw new BadRequestException('elchi_market_id majburiy');
    }
    const mode = whereDeliver === 'center' ? 'center' : 'address';
    const input = parsePartnerTariffQuery(query);
    const res = await firstValueFrom(
      this.identityClient
        .send<{
          data?: Array<{
            id: string | number;
            username?: string | null;
            tariff_home?: number | null;
            tariff_center?: number | null;
            region_id?: string | null;
            district_id?: string | null;
            weight_volume_pricing?: boolean | null;
          }>;
        }>({ cmd: 'identity.market.find_by_ids' }, { ids: [elchiMarketId] })
        .pipe(timeout(8000)),
    );
    const market = (res?.data ?? [])[0];
    // fix3 RBAC-13: faqat shu hamkor ochgan market. Begona market ham
    // "topilmadi" (404) — mavjudligi haqida ma'lumot sizmasin.
    if (!market || !isPartnerProvisionedMarket(market, request?.partner?.id)) {
      throw new NotFoundException('Market topilmadi');
    }

    const tariffInput = {
      snapshot: null,
      isCenter: mode === 'center',
      centerTariff: market.tariff_center,
      homeTariff: market.tariff_home,
    };
    const profile = resolveOrderTariffDetailed(tariffInput);
    const engineActive = isSalePricingEngineActive(
      readSalePricingConfig(),
      elchiMarketId,
      market,
    );
    const quote =
      input.measure ||
      input.express ||
      input.pickup ||
      engineActive ||
      !profile.standard
        ? await this.fetchPartnerQuote(
            buildPartnerQuotePayload(mode, market, input),
          )
        : null;
    if (profile.standard === null && !quote) {
      throw new ServiceUnavailableException(
        'Yetkazish tarifini hisoblab bo‘lmadi, keyinroq qayta urinib ko‘ring',
      );
    }
    const resolution =
      quote && (engineActive || profile.standard === null)
        ? resolveOrderTariffDetailed({
            ...tariffInput,
            engine: toPartnerEngineQuote(quote),
          })
        : profile;

    return successRes(
      {
        elchi_market_id: String(elchiMarketId),
        where_deliver: mode,
        market_tariff: resolution.tariff,
        tariff_source: resolution.source,
        estimated: quote ? quote.estimated === true : true,
        quote: quote ? toPartnerQuote(quote) : null,
      },
      200,
      'tariff',
    );
  }

  /**
   * Dvigatel hisobi. Kirish xatosi (400) — hamkorga; boshqa har qanday xato —
   * `null`: tarif sotuvdagidek profilga tushadi, hamkor oqimi to'xtamaydi.
   */
  private async fetchPartnerQuote(
    payload: ReturnType<typeof buildPartnerQuotePayload>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await firstValueFrom(
        this.logisticsClient
          .send<{
            data?: Record<string, unknown>;
          }>({ cmd: 'logistics.delivery.sale_quote' }, payload)
          .pipe(timeout(8000)),
      );
      return res?.data ?? null;
    } catch (error) {
      const failure = error as { statusCode?: unknown; message?: unknown };
      const message =
        typeof failure?.message === 'string' ? failure.message : String(error);
      if (failure?.statusCode === 400) {
        throw new BadRequestException(message);
      }
      this.logger.warn(
        `6tGZzupr: yetkazish narxi dvigateli javob bermadi, profil tarifi olindi: ${message}`,
      );
      return null;
    }
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
  async provisionMarket(
    @Req() request: { partner: PartnerPrincipal },
    @Body() dto: CreatePartnerMarketRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = await firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.provision_market' },
          {
            ...dto,
            partner_id: request.partner.id,
            requester: { id: `partner:${request.partner.id}` },
          },
        )
        .pipe(timeout(8000)),
    );
    return syncHttpStatus(res, body);
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
  async provisionShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Body() dto: CreatePartnerShipmentRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = await firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.create_shipment' },
          { ...dto, partner_id: request.partner.id },
        )
        .pipe(timeout(PARTNER_SHIPMENT_TIMEOUT_MS)),
    );
    return syncHttpStatus(res, body);
  }

  /**
   * KO'P POSILKA HOLATI BITTA SO'ROVDA (M4ViM9jz) — hamkor solishtiruvchisi
   * uchun. Har element `GET /partner/shipments/:id` bilan bir xil;
   * topilmaganlari `not_found` da. Hech narsa yaratmaydi — 200.
   */
  @Post('shipments/status')
  @HttpCode(200)
  @ApiOperation({
    summary: "Ko'p posilka holati (100 tagacha) — { items, not_found, failed }",
  })
  @ApiBody({ type: PartnerShipmentsStatusRequestDto })
  @ApiOkResponse({
    description:
      'items[] — GET /partner/shipments/:id shaklida; not_found[] — topilmagan id lar',
  })
  getShipmentsStatus(
    @Req() request: { partner: PartnerPrincipal },
    @Body() dto: PartnerShipmentsStatusRequestDto,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.get_shipments_bulk' },
          { shipment_ids: dto.shipment_ids, partner_id: request.partner.id },
        )
        .pipe(timeout(PARTNER_SHIPMENT_TIMEOUT_MS)),
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
      '{ shipment_id, external_order_id, status, cod_amount, cod_collected, total_price, tracking }. ' +
      "`cod_amount` = to'lanishi kerak summa; `cod_collected` = kuryer mijozdan " +
      'HAQIQATAN yiqqan pul (sotuvgacha 0) — pul solishtiruvi uchun.',
  })
  @ApiNotFoundResponse({ description: 'Shipment topilmadi' })
  getShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Param('id') id: string,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.get_shipment' },
          { shipment_id: id, partner_id: request.partner.id },
        )
        .pipe(timeout(8000)),
    );
  }

  /**
   * Posilkani YANGILASH (Fnu6PRya) — narx, manzil, mahsulotlar, izoh.
   *
   * Ilgari bunday yo'l yo'q edi: takroriy `POST` idempotent bo'lib birinchi
   * yuborilgan narxni abadiy muzlatardi va kuryer eski summani undirardi.
   * Narx/mahsulot faqat Elchi qabul qilmaguncha, manzil filialga
   * jo'natilmaguncha o'zgaradi; aks holda 409. Faqat hamkorning o'z posilkasi.
   * Javob `GET /partner/shipments/:id` bilan bir xil shaklda.
   */
  @Patch('shipments/:id')
  @ApiOperation({
    summary:
      'Shipment yangilash (narx/manzil/mahsulot/izoh). Qabul qilingan ' +
      'posilka narxi -> 409, yakuniy holat -> 409.',
  })
  @ApiBody({ type: UpdatePartnerShipmentRequestDto })
  @ApiOkResponse({
    description:
      '{ shipment_id, status, cod_amount, total_price, ..., updated_fields }',
  })
  @ApiNotFoundResponse({ description: 'Shipment topilmadi' })
  @ApiConflictResponse({
    description: 'Posilka holati bu o‘zgarishga ruxsat bermaydi',
  })
  updateShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Param('id') id: string,
    @Body() dto: UpdatePartnerShipmentRequestDto,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.update_shipment' },
          { ...dto, shipment_id: id, partner_id: request.partner.id },
        )
        .pipe(timeout(PARTNER_SHIPMENT_TIMEOUT_MS)),
    );
  }

  /**
   * Posilkani bekor qilish. Yetkazib bo'lingan posilkani bekor qilib bo'lmaydi
   * (409). Faqat hamkorning o'z posilkasi.
   */
  /**
   * ⚠️ `@HttpCode(200)` ATAYLAB. Bekor qilish HECH NARSA YARATMAYDI, lekin
   * NestJS `@Post` uchun sukut bo'yicha 201 beradi. Takroriy bekor qilish
   * ham idempotent 200 qaytaradi (409 EMAS — allaqachon bekor qilingan
   * posilkani yana bekor qilish xato holat emas). 409 faqat YETKAZILGAN
   * posilkani bekor qilishga urinishda chiqadi.
   */
  @Post('shipments/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Shipment bekor qilish. Sotilganni bekor qilish -> 409. ' +
      'Allaqachon bekor qilinganni qayta bekor qilish -> 200 (idempotent).',
  })
  @ApiOkResponse({ description: '{ shipment_id, status: "cancelled" }' })
  @ApiNotFoundResponse({ description: 'Shipment topilmadi' })
  cancelShipment(
    @Req() request: { partner: PartnerPrincipal },
    @Param('id') id: string,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.cancel_shipment' },
          { shipment_id: id, partner_id: request.partner.id },
        )
        .pipe(timeout(10000)),
    );
  }
}
