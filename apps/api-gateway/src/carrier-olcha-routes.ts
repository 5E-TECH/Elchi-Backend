import {
  applyDecorators,
  HttpCode,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import {
  CarrierThrottlerGuard,
  carrierThrottleLimit,
  carrierThrottleTtlMs,
  readPositiveIntEnv,
} from './auth/carrier-throttler.guard';
import { Public } from './auth/public.decorator';
import { CarrierOlchaExceptionFilter } from './carrier-olcha-compat';
import {
  CARRIER_API_KEY_SCHEME,
  CARRIER_BEARER_SCHEME,
} from './carrier-swagger';
import {
  CarrierAuthTokenRequestDto,
  CarrierAuthTokenResponseDto,
  CarrierOlchaErrorDto,
  CarrierQrOrderFailDto,
  CarrierQrOrderRequestDto,
  CarrierQrOrderResponseDto,
} from './dto/carrier.swagger.dto';

/**
 * CARRIER API YO'L DEKORATORLARI — bitta manba.
 *
 * Olcha uslubidagi ikki endpoint IKKI manzilda ochiq (ega 2026-11-27):
 *   `/carrier/auth/token`, `/carrier/qrorder/find`  — Elchi Carrier API ostida;
 *   `/auth/token`,         `/qrorder/find`          — Olcha'dagi kabi prefikssiz
 *     (`carrier-olcha-root-gateway.controller.ts`): Olcha bilan ishlaydigan
 *     tizim faqat domenni almashtiradi (api.olchamarket.uz → api.elchipochta.uz).
 *
 * Kirish, limit, xato filtri va Swagger hujjati shu yerdagi dekoratorlardan
 * olinadi — ikki manzil bir-biridan ajralib ketmasin
 * (`carrier-olcha-root.spec.ts` metadata'ni solishtiradi).
 */

/**
 * Per-carrier rate limit — env HAR SO'ROVDA o'qiladi (`@Throttle` resolvable,
 * `carrier-throttler.guard.ts`): bo'sh/xato qiymat sukutga tushadi.
 */
export const CARRIER_THROTTLE = {
  default: { limit: carrierThrottleLimit, ttl: carrierThrottleTtlMs },
};

/**
 * Token so'rovi limiti — bitta IP'dan daqiqasiga (global IP throttler,
 * `@Throttle`). Token 1 soat yashaydi: oddiy mijoz soatiga bir marta so'raydi.
 */
export const carrierAuthThrottleLimit = (): number =>
  readPositiveIntEnv('CARRIER_AUTH_THROTTLE_LIMIT', 20);

/** Qaysi manzil uchun: `/carrier/...` yoki Olcha'dagi kabi prefikssiz. */
export type CarrierOlchaPathVariant = 'carrier' | 'root';

const ROOT_NOTE =
  ' Bu — Olcha bilan AYNI manzil (prefikssiz): Olcha bilan ishlaydigan tizim faqat domenni ' +
  'almashtiradi (`https://api.olchamarket.uz` → `https://api.elchipochta.uz`). ' +
  'Ishlashi `/carrier/...` dagi yo‘l bilan bir xil.';

const summaryFor = (summary: string, variant: CarrierOlchaPathVariant) =>
  variant === 'root' ? `${summary} — Olcha manzili` : summary;

/**
 * CARRIER API KIRISHI: `X-Api-Key` YOKI Olcha uslubidagi Bearer token,
 * akkaunt limiti (`CarrierThrottlerGuard`). `@Public()` — xodim JWT'si
 * (global `JwtAuthGuard`) bu yo'lda TEKSHIRILMAYDI va o'tkazmaydi ham:
 * kirishni faqat `CarrierApiKeyGuard` hal qiladi (xodim tokeni — 401).
 *
 * `CarrierGatewayController` da klass darajasida, prefikssiz `/qrorder/find`
 * da metod darajasida. Swagger'da `security` tartibi: Bearer, keyin kalit.
 */
export const CarrierApiAccess = () =>
  applyDecorators(
    ApiBearerAuth(CARRIER_BEARER_SCHEME),
    ApiSecurity(CARRIER_API_KEY_SCHEME),
    Throttle(CARRIER_THROTTLE),
    UseGuards(CarrierApiKeyGuard, CarrierThrottlerGuard),
    Public(),
  );

/**
 * `POST auth/token` — https://api.olchamarket.uz/swagger `POST /auth/token`
 * bilan AYNI. Kirishsiz (`@Public`), bitta IP'dan daqiqasiga 20, xatolar
 * Olcha (Yii2) shaklida — xodimlar `/auth/*` filtri va limiti EMAS.
 */
export const CarrierAuthTokenRoute = (variant: CarrierOlchaPathVariant) =>
  applyDecorators(
    Public(),
    UseFilters(new CarrierOlchaExceptionFilter('auth')),
    Post('auth/token'),
    HttpCode(200),
    Throttle({
      default: { limit: carrierAuthThrottleLimit, ttl: () => 60_000 },
    }),
    ApiOperation({
      summary: summaryFor('JWT token olish (Olcha uslubi)', variant),
      description:
        'Olcha API `POST /auth/token` bilan bir xil. `username` (carrier akkaunt ID) va `password` ' +
        '(API kalit `elc_…`) orqali JWT access token olinadi. Tokenni boshqa carrier endpointlarga ' +
        '`Authorization: Bearer <access_token>` sarlavhasi bilan yuboring. Token amal qilish muddati — ' +
        '1 soat (`expires_in=3600`). Kalit almashtirilsa (rotate) eski tokenlar darhol bekor bo‘ladi.' +
        (variant === 'root' ? ROOT_NOTE : ''),
    }),
    ApiConsumes('application/json', 'application/x-www-form-urlencoded'),
    ApiBody({ type: CarrierAuthTokenRequestDto }),
    ApiOkResponse({
      description: 'Muvaffaqiyatli — access token qaytadi',
      type: CarrierAuthTokenResponseDto,
    }),
    ApiBadRequestResponse({
      description: 'username yoki password yuborilmagan',
      type: CarrierOlchaErrorDto,
    }),
    ApiUnauthorizedResponse({
      description: 'Login yoki parol noto‘g‘ri',
      type: CarrierOlchaErrorDto,
    }),
    ApiForbiddenResponse({
      description:
        'Akkaunt yoki bog‘langan kurier faol emas (error_code CARRIER_COURIER_INACTIVE), yoki IP ruxsat etilmagan',
      type: CarrierOlchaErrorDto,
    }),
    ApiTooManyRequestsResponse({
      description: 'Bitta IP’dan daqiqasiga 20 so‘rovdan ko‘p',
      type: CarrierOlchaErrorDto,
    }),
    ApiServiceUnavailableResponse({
      description: 'Vaqtinchalik xato — birozdan keyin qayta urining',
      type: CarrierOlchaErrorDto,
    }),
  );

/**
 * `POST qrorder/find` — https://api.olchamarket.uz/swagger `POST /qrorder/find`
 * bilan AYNI so'rov va javob. Kirish (`CarrierApiAccess`) bu yerga KIRMAYDI:
 * `/carrier/qrorder/find` uni klassdan oladi, prefikssiz yo'l — metoddan.
 *
 * Xato shakllari (`CarrierOlchaExceptionFilter('result')`): 401/403/429 —
 * Yii2 `{name, message, code: 0, status}`; 400/404 — HTTP 200 da
 * `{success: false, msg, status}`; 5xx — o'z HTTP holati bilan, ayni shakl.
 */
export const CarrierQrOrderFindRoute = (variant: CarrierOlchaPathVariant) =>
  applyDecorators(
    Post('qrorder/find'),
    HttpCode(200),
    UseFilters(new CarrierOlchaExceptionFilter('result')),
    ApiOperation({
      summary: summaryFor(
        'QR kod orqali buyurtmani topish (Olcha uslubi)',
        variant,
      ),
      description:
        'Olcha API `POST /qrorder/find` bilan bir xil. QR orqali sizga biriktirilgan buyurtmani topib, ' +
        'uning ma’lumotlarini qaytaradi. Faqat yetkazilmoqda holatidagi buyurtmalar qaytariladi; aks holda ' +
        '`{success: false, msg: <sabab>, status: 400|404}` (HTTP 200). Yo‘ldagi posilka shu chaqiruvda ' +
        'sizga qabul qilinadi (`status: waiting`) — natijani `POST /carrier/orders/{id}/status` bilan yuboring.' +
        (variant === 'root' ? ROOT_NOTE : ''),
    }),
    ApiBody({ type: CarrierQrOrderRequestDto }),
    ApiExtraModels(CarrierQrOrderResponseDto, CarrierQrOrderFailDto),
    ApiOkResponse({
      description:
        'Natija: muvaffaqiyat (`CarrierQrOrderResponseDto`) yoki 400/404 xato (`CarrierQrOrderFailDto`)',
      schema: {
        oneOf: [
          { $ref: getSchemaPath(CarrierQrOrderResponseDto) },
          { $ref: getSchemaPath(CarrierQrOrderFailDto) },
        ],
      },
    }),
    ApiUnauthorizedResponse({
      description: 'Token (yoki X-Api-Key) yuborilmagan yoki yaroqsiz',
      type: CarrierOlchaErrorDto,
    }),
    ApiForbiddenResponse({
      description:
        'Akkaunt yoki bog‘langan kurier faol emas (error_code CARRIER_COURIER_INACTIVE), yoki IP ruxsat etilmagan',
      type: CarrierOlchaErrorDto,
    }),
    ApiTooManyRequestsResponse({
      description:
        'Limit: akkaunt uchun daqiqasiga 120 so‘rov (barcha endpoint birgalikda)',
      type: CarrierOlchaErrorDto,
    }),
    ApiServiceUnavailableResponse({
      description:
        'Vaqtinchalik xato (error_code CARRIER_KEY_CHECK_UNAVAILABLE / CARRIER_TEMPORARILY_UNAVAILABLE) — qayta urining',
      type: CarrierQrOrderFailDto,
    }),
    ApiGatewayTimeoutResponse({
      description: 'Ichki xizmat vaqtida javob bermadi — qayta urining',
      type: CarrierQrOrderFailDto,
    }),
  );
