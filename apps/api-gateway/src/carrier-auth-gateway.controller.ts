import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CARRIER_ERROR_CODES } from '@app/common';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { readPositiveIntEnv } from './auth/carrier-throttler.guard';
import { CarrierTokenService } from './auth/carrier-token.service';
import { Public } from './auth/public.decorator';
import { CarrierOlchaExceptionFilter } from './carrier-olcha-compat';
import {
  CarrierAuthTokenRequestDto,
  CarrierAuthTokenResponseDto,
  CarrierOlchaErrorDto,
} from './dto/carrier.swagger.dto';

/** Olcha (Yii2) 401 matni — `AuthTokenRequest` xatosi bilan bir xil. */
export const CARRIER_AUTH_INVALID_MESSAGE = 'Invalid username or password.';

/**
 * Token so'rovi limiti — bitta IP'dan daqiqasiga (global IP throttler,
 * `@Throttle`). Token 1 soat yashaydi: oddiy mijoz soatiga bir marta so'raydi.
 */
export const carrierAuthThrottleLimit = (): number =>
  readPositiveIntEnv('CARRIER_AUTH_THROTTLE_LIMIT', 20);

type AuthRequest = {
  headers: Record<string, unknown>;
  ip?: string;
  ips?: string[];
};

const field = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/**
 * CARRIER API — OLCHA USLUBIDAGI TOKEN (`POST /carrier/auth/token`).
 *
 * https://api.olchamarket.uz/swagger `POST /auth/token` bilan AYNI: JSON yoki
 * `application/x-www-form-urlencoded` `{username, password}` →
 * `{access_token, token_type: "Bearer", expires_in: 3600}`; noto'g'ri bo'lsa
 * 401 `{name, message: "Invalid username or password.", code: 0, status}`.
 *
 * Login/parol YANGI SIR EMAS: `username` — carrier akkaunt ID'si, `password`
 * — o'sha akkauntning `elc_` API kaliti. Shuning uchun migratsiya yo'q va
 * kalitning butun hayoti (rotatsiya, to'xtatish, IP ro'yxati, kurier holati)
 * token yo'lida ham AYNAN ishlaydi: tekshiruv `CarrierApiKeyGuard.admit`.
 *
 * Kontrakt: docs/public/CARRIER_API.md §10.
 */
@ApiTags('Carrier')
@Public()
@UseFilters(new CarrierOlchaExceptionFilter('auth'))
@Controller('carrier')
export class CarrierAuthGatewayController {
  private readonly logger = new Logger(CarrierAuthGatewayController.name);

  constructor(
    private readonly keys: CarrierApiKeyGuard,
    private readonly tokens: CarrierTokenService,
  ) {}

  @Post('auth/token')
  @HttpCode(200)
  @Throttle({
    default: { limit: carrierAuthThrottleLimit, ttl: () => 60_000 },
  })
  @ApiOperation({
    summary: 'JWT token olish (Olcha uslubi)',
    description:
      'Olcha API `POST /auth/token` bilan bir xil. `username` (carrier akkaunt ID) va `password` ' +
      '(API kalit `elc_…`) orqali JWT access token olinadi. Tokenni boshqa `/carrier/*` endpointlarga ' +
      '`Authorization: Bearer <access_token>` sarlavhasi bilan yuboring. Token amal qilish muddati — ' +
      '1 soat (`expires_in=3600`). Kalit almashtirilsa (rotate) eski tokenlar darhol bekor bo‘ladi.',
  })
  @ApiConsumes('application/json', 'application/x-www-form-urlencoded')
  @ApiBody({ type: CarrierAuthTokenRequestDto })
  @ApiOkResponse({
    description: 'Muvaffaqiyatli — access token qaytadi',
    type: CarrierAuthTokenResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'username yoki password yuborilmagan',
    type: CarrierOlchaErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Login yoki parol noto‘g‘ri',
    type: CarrierOlchaErrorDto,
  })
  @ApiForbiddenResponse({
    description:
      'Akkaunt yoki bog‘langan kurier faol emas (error_code CARRIER_COURIER_INACTIVE), yoki IP ruxsat etilmagan',
    type: CarrierOlchaErrorDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Bitta IP’dan daqiqasiga 20 so‘rovdan ko‘p',
    type: CarrierOlchaErrorDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Vaqtinchalik xato — birozdan keyin qayta urining',
    type: CarrierOlchaErrorDto,
  })
  async token(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthRequest,
  ): Promise<CarrierAuthTokenResponseDto> {
    const username = field(body?.username);
    const password = field(body?.password);
    if (!username || !password) {
      throw new BadRequestException('username va password majburiy');
    }

    const found = await this.keys.resolveByKey(password);
    /**
     * Kalit topilmadi YOKI boshqa akkauntniki — bitta javob: login/parolning
     * qaysi biri xatoligi aytilmaydi.
     */
    if (!found || String(found.id) !== username) {
      throw new UnauthorizedException(CARRIER_AUTH_INVALID_MESSAGE);
    }
    // Faol emas / IP / kurier — `X-Api-Key` yo'lidagi AYNI qaror (403).
    this.keys.admit(req, found);
    /**
     * Barmoq izisiz token rotatsiyada bekor bo'lmasdi — bermaymiz. Faqat
     * rolling deploy oralig'ida (eski integration-service) bo'lishi mumkin.
     */
    if (!found.token_fp || !/^[0-9a-f]{32}$/.test(found.token_fp)) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: "Token berib bo'lmadi — birozdan keyin qayta urining",
        code: CARRIER_ERROR_CODES.KEY_CHECK_UNAVAILABLE,
      });
    }
    this.logger.log(`carrier ${found.id}: access token issued`);
    return this.tokens.issue({
      id: String(found.id),
      token_fp: found.token_fp,
    });
  }
}
