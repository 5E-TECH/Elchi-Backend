import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Public } from '../auth/public.decorator';
import {
  PublicDeliveryQuoteRequestDto,
  PublicDeliveryQuoteResponseDto,
  PublicDeliveryTariffDto,
  PublicDeliveryTariffsResponseDto,
} from '../dto/public-delivery-pricing.swagger.dto';
import {
  PUBLIC_PRICING_THROTTLE,
  PUBLIC_QUOTE_FLAT_FIELDS,
  PublicPricingCache,
  publicPricingCacheTtlMs,
  toLogisticsQuotePayload,
  toPublicQuote,
  toPublicTariffs,
} from './public-delivery-pricing';

const LOGISTICS_TIMEOUT_MS = 8000;
/** Turli kirishlar keshi (har gateway jarayonida). */
const QUOTE_CACHE_MAX_ENTRIES = 2000;

const errorStatus = (error: unknown): number | null => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : null;
};

const errorMessage = (error: unknown, fallback: string): string => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
};

/**
 * mSkzzNBJ — ochiq (tokensiz) yetkazish narxi: elchipochta.uz kalkulyatori
 * va tariflar jadvali. BACKEND YAGONA MANBA — hisob logistics-service'ning
 * O'SHA `logistics.delivery.quote` RPC'sida (`computeDeliveryQuote`,
 * ikkinchi nusxa yo'q); tokenli `POST /delivery/quote` o'zgarmagan.
 *
 * - `@Public()`; per-IP `PUBLIC_PRICING_THROTTLE` (sukut 30/daqiqa, global
 *   limitdan yuqori emas) — ortig'i 429.
 * - Kirish qat'iy: faqat o'lchov (`product_id` — 400), viloyat id'lari.
 *   Yo'q viloyat — 400 (logistics 404 → 400: ochiq kalkulyator uchun bu
 *   kirish xatosi), manfiy/noto'g'ri o'lcham — 400.
 * - Javob — faqat hisob (`toPublicQuote`); tarif qatori id'si, sozlama id'si,
 *   versiya sanasi, mahsulot/viloyat id'lari chiqmaydi.
 * - Qisqa TTL kesh (`PUBLIC_PRICING_CACHE_TTL_MS`, sukut 30 s): bir xil
 *   kirish va tariflar jadvali RMQ/DB'ga qayta bormaydi; admin tarifni
 *   o'zgartirsa sayt kesh muddatidan keyin yangi narxni ko'rsatadi.
 */
@ApiTags('Public delivery pricing')
@ApiExtraModels(PublicDeliveryTariffDto)
@Public()
@Controller('public')
export class PublicDeliveryPricingController {
  private readonly quoteCache = new PublicPricingCache(
    publicPricingCacheTtlMs(),
    QUOTE_CACHE_MAX_ENTRIES,
  );
  private readonly tariffsCache = new PublicPricingCache(
    publicPricingCacheTtlMs(),
    1,
  );

  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
  ) {}

  private send<T>(cmd: string, payload: object): Promise<T> {
    return firstValueFrom(
      this.logisticsClient
        .send<T>({ cmd }, payload)
        .pipe(timeout(LOGISTICS_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Logistics service response timeout');
      }
      throw error;
    });
  }

  @Post('delivery-quote')
  @HttpCode(200)
  @Throttle(PUBLIC_PRICING_THROTTLE)
  @ApiOperation({
    summary:
      'Ochiq yetkazish narxi kalkulyatori (tokensiz; hech narsa yozilmaydi) — mSkzzNBJ',
    description:
      'Autentifikatsiyasiz (elchipochta.uz kalkulyatori). Hisob tokenli `POST /delivery/quote` bilan AYNI dvigatel (logistics `logistics.delivery.quote`). ' +
      "Posilka: yuqori darajadagi `weight_kg` (+ ixtiyoriy `length_cm`/`width_cm`/`height_cm` — uchalasi birga, `volumetric_enabled`) YOKI `items[]` (≤ 20, bitta jo'natma). " +
      '`product_id` qabul qilinmaydi (400). `pickup: true` — bitta posilkali tashrif: `pickupFee` va `totalWithPickup` ga kiradi, `total` ga emas. ' +
      "Tarif: ikkala viloyat ham shahar zonasida → `city`, aks holda `where_deliver`. Javobda faqat hisob — tarif/sozlama id'lari yo'q. " +
      "Xatolar: 400 (validatsiya, yo'q viloyat), 409 (faol tarif yo'q), 429 (per-IP limit, sukut 30/daqiqa), 504. Javob ≤ 30 s keshlanadi.",
  })
  @ApiBody({ type: PublicDeliveryQuoteRequestDto })
  @ApiOkResponse({ type: PublicDeliveryQuoteResponseDto })
  @ApiBadRequestResponse({
    description: "Noto'g'ri kirish (manfiy o'lcham, product_id, yo'q viloyat)",
  })
  @ApiTooManyRequestsResponse({ description: 'Per-IP limit' })
  async quote(@Body() dto: PublicDeliveryQuoteRequestDto) {
    if (dto.items !== undefined) {
      const flat = PUBLIC_QUOTE_FLAT_FIELDS.filter(
        (key) => dto[key] !== undefined && dto[key] !== null,
      );
      if (flat.length) {
        throw new BadRequestException(
          `items bilan ${flat.join(', ')} birga yuborilmaydi — yo items[], yo bitta posilka maydonlari`,
        );
      }
    }
    const payload = toLogisticsQuotePayload(dto);
    const data = await this.quoteCache.getOrLoad(
      JSON.stringify(payload),
      async () => {
        const res = await this.send<{ data?: unknown }>(
          'logistics.delivery.quote',
          payload,
        ).catch((error: unknown) => {
          // Yo'q viloyat (logistics 404) — ochiq kalkulyator uchun kirish xatosi.
          if (errorStatus(error) === 404) {
            throw new BadRequestException(
              errorMessage(error, 'Viloyat topilmadi'),
            );
          }
          // Faol tarif/sozlama yo'q — ichki tafsilot (migratsiya nomi) chiqmasin.
          if (errorStatus(error) === 409) {
            throw new ConflictException(
              'Yetkazish tarifi hozircha sozlanmagan',
            );
          }
          throw error;
        });
        return toPublicQuote(res?.data);
      },
    );
    return { statusCode: 200, message: 'success', data };
  }

  @Get('delivery-tariffs')
  @Throttle(PUBLIC_PRICING_THROTTLE)
  @ApiOperation({
    summary:
      'Ochiq tariflar jadvali + formula sozlamalari + viloyatlar (tokensiz) — mSkzzNBJ',
    description:
      "elchipochta.uz tariflar jadvali, pickup matni (`pickup_fee`, `pickup_free_from_count`) va kalkulyator hudud tanlovi shu javobdan chiziladi — raqamlar landing repo'sida saqlanmaydi. " +
      "Faqat HOZIRGI qiymatlar: versiyalar, tarix, `created_by`, id'lar yo'q. Per-IP limit (sukut 30/daqiqa), javob ≤ 30 s keshlanadi.",
  })
  @ApiOkResponse({ type: PublicDeliveryTariffsResponseDto })
  @ApiTooManyRequestsResponse({ description: 'Per-IP limit' })
  async tariffs() {
    const data = await this.tariffsCache.getOrLoad('tariffs', async () => {
      const [tariffs, settings, regions] = await Promise.all([
        this.send<{ data?: { current?: unknown } }>(
          'logistics.delivery.tariffs.find_all',
          { limit: 1 },
        ),
        this.send<{ data?: unknown }>('logistics.delivery.settings.get', {}),
        this.send<{ data?: unknown }>('logistics.region.find_all', {}),
      ]);
      return toPublicTariffs({
        current: tariffs?.data?.current,
        settings: settings?.data,
        regions: regions?.data,
      });
    });
    return { statusCode: 200, message: 'success', data };
  }
}
