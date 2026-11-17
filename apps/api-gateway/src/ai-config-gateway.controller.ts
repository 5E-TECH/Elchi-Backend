import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import {
  AI_CONFIG_PATTERNS as P,
  AI_CONFIG_PUBLIC_ERROR_FIELDS,
  RMQ_GATEWAY_TIMEOUT,
  Roles as RoleEnum,
  requestContext,
  type AiConfigErrorCode,
  type AiConfigRequester,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AiConfigKeyThrottlerGuard } from './auth/ai-config-key-throttler.guard';
import {
  AiDeactivateDto,
  AiKeySetDto,
  AiVersionedDto,
} from './dto/ai-config.dto';
import { AiStatusPoller } from './ai/ai-status.poller';

interface AuthedRequest {
  user?: { sub?: string | number; roles?: unknown[] };
}

/**
 * «AI kalit va modellar» (be-brief §8, openapi-fragment v0.2). FAQAT
 * SUPERADMIN (ADMIN → 403). Barcha qaror ai-service'da: imzo, ruxsat
 * ro'yxati, vaqt oynalari, step-up talabi.
 *
 * - RMQ: `AI_CONFIG` mijozi → `ai_config_queue` (DLX'siz, saqlanmaydi,
 *   TTL 8 s). Xabar HMAC bilan imzolanadi (kind `gateway`) —
 *   `RMQ_REQUESTER_SIG_MODE` dan qat'i nazar (serializer).
 * - Har chaqiruv: `{ requester, ...payload, sent_at: Date.now() }`,
 *   `timeout(RMQ_GATEWAY_TIMEOUT)`, qayta yuborish YO'Q. Timeout → 504
 *   (kodsiz) — ai-service 6.5 s dan keyin COMMIT qilmaydi, ya'ni 504 =
 *   hech narsa o'zgarmagan.
 * - `{ok:false, error}` → `HttpException` (`code` + oq ro'yxatdagi
 *   maydonlar). Bu kodlarning HECH BIRI 401 emas.
 *
 * ⚠️ MAXFIYLIK: tana (muhrlangan konvert) va RMQ payload hech qayerda
 * logga yozilmaydi.
 */
@ApiTags('AI config')
@ApiBearerAuth()
@Controller('ai/config')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN)
export class AiConfigGatewayController {
  constructor(
    @Inject('AI_CONFIG') private readonly client: ClientProxy,
    @Optional() private readonly poller?: AiStatusPoller,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'AI kalit va modellar: sozlama ko‘rinishi (faqat superadmin)',
    description:
      '`data` = AiConfigView (openapi-fragment v0.2). Kalit qiymati yoki shifrmatni HECH QACHON qaytmaydi. ' +
      '`AI_CONFIG_UI_ENABLED=false` da ham ishlaydi (faqat ko‘rish; `key_locked_reason: feature_off`). ' +
      '`key_wrap` — brauzer kalitni muhrlaydigan ai-service ochiq kaliti (yozish mumkin bo‘lmasa null).',
  })
  get(@Req() req: AuthedRequest): Promise<unknown> {
    return this.call(P.GET, req, {}, false);
  }

  @Put('key')
  @HttpCode(200)
  @UseGuards(AiConfigKeyThrottlerGuard)
  @ApiOperation({
    summary: 'Anthropic kalitini qo‘shish yoki almashtirish (muhrlangan)',
    description:
      'Brauzer `{api_key, uid, nonce}` ni `key_wrap` bilan muhrlaydi (AiKeyEnvelope). Bepul tekshiruv (`GET /v1/models`) → ' +
      'shifrlab saqlash; audit `ai.key.add|replace`. Xatolar: 400 AI_KEY_FORMAT / AI_KEY_ADMIN_KEY / AI_KEY_OAUTH_TOKEN / ' +
      'AI_KEY_WRAP_INVALID / AI_CONFIG_INVALID {field}; 403 AI_CONFIG_UI_DISABLED / AI_CONFIG_NOT_ALLOWED / AI_CONFIG_UNSIGNED / ' +
      'AI_STEP_UP_REQUIRED; 409 AI_CONFIG_CONFLICT {version} / AI_KEY_SAME / AI_KEY_WRAP_STALE; 422 AI_KEY_REJECTED / ' +
      'AI_KEY_FORBIDDEN / AI_KEY_BAD_REQUEST / AI_KEY_BILLING; 429 AI_KEY_ATTEMPTS_EXCEEDED / AI_KEY_UPSTREAM_RATE_LIMITED ' +
      '{retry_after_seconds}; 502 AI_KEY_VERIFY_UNAVAILABLE; 503 AI_KEY_STORAGE_UNAVAILABLE / AI_CONFIG_EXPIRED; 504 (kodsiz) — ' +
      'hech narsa o‘zgarmagan. Javob — yangilangan AiConfigView.',
  })
  @ApiBody({ type: AiKeySetDto })
  setKey(@Body() dto: AiKeySetDto, @Req() req: AuthedRequest) {
    return this.call(
      P.KEY_SET,
      req,
      {
        key_envelope: { ...dto.key_envelope },
        label: dto.label,
        version: dto.version,
      },
      true,
    );
  }

  @Post('key/verify')
  @HttpCode(200)
  @UseGuards(AiConfigKeyThrottlerGuard)
  @ApiOperation({
    summary: 'Ishlatilayotgan kalitni qayta tekshirish (bepul)',
    description:
      'UI kaliti (yoki u yo‘q bo‘lsa server kaliti) `GET /v1/models` bilan tekshiriladi; aniq rad ham 200 — natija ' +
      '`verify.state` da. Audit `ai.key.verify`. Step-up talab qilinmaydi. 404 AI_KEY_NONE; 429 AI_KEY_ATTEMPTS_EXCEEDED.',
  })
  verifyKey(@Req() req: AuthedRequest) {
    return this.call(P.KEY_VERIFY, req, {}, true);
  }

  @Post('key/restore-previous')
  @HttpCode(200)
  @UseGuards(AiConfigKeyThrottlerGuard)
  @ApiOperation({
    summary: 'Oldingi kalitga qaytarish (qayta tekshiruv bilan)',
    description:
      'Faol ↔ oldingi almashadi. 404 AI_KEY_NO_PREVIOUS; 409 AI_CONFIG_CONFLICT; 422/429/502 — tekshiruv natijasi; ' +
      '503 AI_KEY_STORAGE_UNAVAILABLE / AI_CONFIG_EXPIRED. Audit `ai.key.restore`.',
  })
  @ApiBody({ type: AiVersionedDto })
  restoreKey(@Body() dto: AiVersionedDto, @Req() req: AuthedRequest) {
    return this.call(P.KEY_RESTORE, req, { version: dto.version }, true);
  }

  @Post('key/deactivate')
  @HttpCode(200)
  @UseGuards(AiConfigKeyThrottlerGuard)
  @ApiOperation({
    summary:
      'Faol UI kalitini o‘chirish (server kaliti ishlaydi yoki AI o‘chadi)',
    description:
      'Faol → oldingi; eski oldingisi o‘chiriladi (shifrmatn yo‘q qilinadi). Shifr kalitisiz ham ishlaydi — bir bosishda ' +
      'tiklash. Anthropic’da kalitni bekor QILMAYDI. 404 AI_KEY_NONE; 409 AI_CONFIG_CONFLICT; 400 AI_CONFIG_INVALID ' +
      '{field:"reason"}. Audit `ai.key.deactivate`.',
  })
  @ApiBody({ type: AiDeactivateDto })
  deactivateKey(@Body() dto: AiDeactivateDto, @Req() req: AuthedRequest) {
    return this.call(
      P.KEY_DEACTIVATE,
      req,
      { version: dto.version, reason: dto.reason },
      true,
    );
  }

  @Delete('key/previous')
  @HttpCode(200)
  @UseGuards(AiConfigKeyThrottlerGuard)
  @ApiOperation({
    summary: 'Oldingi kalit shifrmatnini o‘chirish',
    description:
      'Faqat jonli bazadan (WAL/zaxiralarda muddati tugaguncha qoladi). Anthropic’da bekor QILMAYDI. ' +
      '404 AI_KEY_NO_PREVIOUS; 409 AI_CONFIG_CONFLICT. Audit `ai.key.forget`.',
  })
  @ApiQuery({ name: 'version', type: Number, required: true })
  forgetPrevious(
    @Query('version', ParseIntPipe) version: number,
    @Req() req: AuthedRequest,
  ) {
    return this.call(P.KEY_FORGET_PREVIOUS, req, { version }, true);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Kalit va model o‘zgarishlari tarixi',
    description:
      '`data` = `{items[{id, action, created_at, actor, details, reason, context{ip, device}}], next_cursor}`. ' +
      'Eng yangisi tepada; tizim qatorlari (rad etilgan urinish, runtime xatosi) ham.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  history(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = limit === undefined ? undefined : Number(limit);
    return this.call(
      P.HISTORY,
      req,
      {
        limit: Number.isInteger(n) ? n : undefined,
        cursor: typeof cursor === 'string' ? cursor.slice(0, 128) : undefined,
      },
      false,
    );
  }

  // ─── Yordamchilar ──────────────────────────────────────────────────────

  private requester(req: AuthedRequest): AiConfigRequester {
    const roles = Array.isArray(req?.user?.roles)
      ? req.user.roles
          .map((r) => (typeof r === 'string' ? r.trim().toLowerCase() : ''))
          .filter(Boolean)
      : [];
    return {
      id: String(req?.user?.sub ?? ''),
      roles,
      name: requestContext.get()?.userName ?? null,
    };
  }

  private async call(
    cmd: string,
    req: AuthedRequest,
    payload: Record<string, unknown>,
    isWrite: boolean,
  ): Promise<unknown> {
    let reply: unknown;
    try {
      reply = await firstValueFrom(
        this.client
          .send(
            { cmd },
            {
              requester: this.requester(req),
              ...payload,
              // BE-5: step-up tokeni tekshirilib iste'mol qilingach true.
              step_up: false,
              sent_at: Date.now(),
            },
          )
          .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Kodsiz 504: FE GET /ai/config ni qayta o'qiydi.
        throw new GatewayTimeoutException('AI service javob bermadi');
      }
      throw new HttpException(
        { statusCode: 502, message: 'AI service xatosi' },
        502,
      );
    }
    return this.unwrap(reply, isWrite);
  }

  private unwrap(reply: unknown, isWrite: boolean): unknown {
    const r = reply as {
      ok?: unknown;
      data?: unknown;
      error?: Record<string, unknown>;
    } | null;
    if (r && r.ok === true) {
      if (isWrite) this.poller?.refreshNow();
      return { statusCode: 200, message: 'success', data: r.data };
    }
    const e = r?.error ?? {};
    let status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    // ⚠️ 401 hech qachon (FE 401 da sessiyani tugatadi).
    if (status === 401 || status < 400 || status > 599) status = 500;
    const code =
      typeof e.code === 'string' &&
      Object.prototype.hasOwnProperty.call(
        AI_CONFIG_PUBLIC_ERROR_FIELDS,
        e.code,
      )
        ? (e.code as AiConfigErrorCode)
        : undefined;
    const body: Record<string, unknown> = {
      statusCode: status,
      message: typeof e.message === 'string' ? e.message.slice(0, 200) : 'Xato',
    };
    if (code) {
      body.code = code;
      for (const f of AI_CONFIG_PUBLIC_ERROR_FIELDS[code]) {
        if (e[f] !== undefined) body[f] = e[f];
      }
    }
    throw new HttpException(body, status);
  }
}
