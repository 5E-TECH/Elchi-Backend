import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import {
  BOT_CHECK_ERROR_TEXT_MAX,
  BOT_HEALTH_PUBLIC_FIELDS,
  NOTIFICATION_BOT_RECHECK_PATTERN,
  Roles as RoleEnum,
  isBotCheckErrorKind,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  NotificationBotDiagnosticsDto,
  NotificationBotHealthResponseDto,
} from './dto/notification-bot-health.swagger.dto';

/** `notification.health` — tez o'qish (servis xotirasidan). */
export const BOT_HEALTH_TIMEOUT_MS = 3_000;
/**
 * `notification.bot.recheck` — servis getMe'ni ko'pi bilan 3,5 s kutadi
 * (`BOT_RECHECK_GETME_TIMEOUT_MS`), gateway undan uzoqroq.
 */
export const BOT_RECHECK_TIMEOUT_MS = 5_000;

/** 503 matnlari (o'zbekcha, foydalanuvchiga ko'rinadi). */
export const BOT_HEALTH_UNAVAILABLE_TEXT = {
  timeout:
    "Bildirishnoma xizmati javob bermadi — bot holatini hozir bilib bo'lmaydi. Birozdan keyin qayta urinib ko'ring.",
  down: "Bildirishnoma xizmati bilan bog'lanib bo'lmadi — bot holatini hozir bilib bo'lmaydi. Birozdan keyin qayta urinib ko'ring.",
} as const;

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const describeRpcError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * Servis javobidagi `bot` → faqat ma'lum maydonlar (oq ro'yxat; servis
 * kelajakda boshqa maydon qo'shsa ham u bu javobga o'z-o'zidan chiqmaydi).
 * Eski notification-service (diagnostika maydonlarisiz) — `null`/`false`.
 */
export function toBotDiagnostics(raw: unknown): NotificationBotDiagnosticsDto {
  const bot = isRecord(raw) ? raw : {};
  const status = bot.error_status;
  return {
    enabled: bot.enabled === true,
    mode: typeof bot.mode === 'string' ? bot.mode : 'off',
    healthy: typeof bot.healthy === 'boolean' ? bot.healthy : null,
    username: typeof bot.username === 'string' ? bot.username : null,
    reason: typeof bot.reason === 'string' ? bot.reason : '',
    checked_at: typeof bot.checked_at === 'string' ? bot.checked_at : null,
    error_kind: isBotCheckErrorKind(bot.error_kind) ? bot.error_kind : null,
    error_status:
      typeof status === 'number' && Number.isInteger(status) ? status : null,
    error_text:
      typeof bot.error_text === 'string'
        ? bot.error_text.slice(0, BOT_CHECK_ERROR_TEXT_MAX)
        : null,
    restart_required: bot.restart_required === true,
  };
}

/**
 * (BOT-DIAG-BE) `GET /notifications/health` (@Public) — `bot` faqat eski
 * maydonlar bilan (`BOT_HEALTH_PUBLIC_FIELDS`): diagnostika (sabab matni,
 * status, vaqt) ochiq javobga sizmaydi (oFfOWGuo P2). Qolgan maydonlar
 * (`service`, `status`, `timestamp`) o'zgarishsiz.
 */
export function toPublicNotificationHealth(reply: unknown): unknown {
  if (!isRecord(reply)) return reply;
  const { bot, ...rest } = reply;
  if (!isRecord(bot)) return rest;
  const publicBot: Rec = {};
  for (const field of BOT_HEALTH_PUBLIC_FIELDS) {
    if (field in bot) publicBot[field] = bot[field];
  }
  return { ...rest, bot: publicBot };
}

/**
 * (BOT-DIAG-BE) «Tizim holati»: Telegram bot nosozligining ANIQ sababi —
 * faqat superadmin (autentifikatsiyali; ochiq readiness ataylab faqat
 * `reported degraded` beradi — oFfOWGuo, u o'zgarmaydi).
 *
 * Throttle ATAYLAB o'chirilmagan (HealthController'dan farqli): global
 * per-IP chegara «Qayta tekshirish»ni ham cheklaydi.
 */
@ApiTags('Health')
@Controller('health')
export class NotificationBotHealthController {
  private readonly logger = new Logger(NotificationBotHealthController.name);

  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  @Get('notification-bot')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOkResponse({ type: NotificationBotHealthResponseDto })
  @ApiServiceUnavailableResponse({
    description:
      'Bildirishnoma xizmati 3 s ichida javob bermadi yoki bog‘lanib bo‘lmadi (o‘zbekcha `message`)',
  })
  @ApiOperation({
    summary:
      'Telegram bot holati va nosozlik sababi (faqat superadmin): `bot.error_kind` (token_rejected | timeout | network | telegram_error | unknown), `error_status`, `error_text` (≤ 200, token yashirilgan), `checked_at`, `restart_required`. Ochiq `/health/readiness` o‘zgarmagan.',
  })
  async notificationBot(): Promise<NotificationBotHealthResponseDto> {
    const reply = await this.ask(
      { cmd: 'notification.health' },
      BOT_HEALTH_TIMEOUT_MS,
    );
    return this.toResponse(reply);
  }

  @Post('notification-bot/recheck')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOkResponse({ type: NotificationBotHealthResponseDto })
  @ApiServiceUnavailableResponse({
    description:
      'Bildirishnoma xizmati 5 s ichida javob bermadi yoki bog‘lanib bo‘lmadi (o‘zbekcha `message`)',
  })
  @ApiOperation({
    summary:
      'Telegram bot tokenini hozir qayta tekshirish (faqat superadmin): getMe ko‘pi bilan 3,5 s kutiladi, javob — yangi holat + `rechecked`. Token rad etilgan (401/404) bo‘lsa tekshirilmaydi: `rechecked: false`, `bot.restart_required: true` (yangi token bilan restart kerak).',
  })
  async recheckNotificationBot(): Promise<NotificationBotHealthResponseDto> {
    const reply = await this.ask(
      { cmd: NOTIFICATION_BOT_RECHECK_PATTERN },
      BOT_RECHECK_TIMEOUT_MS,
    );
    return {
      ...this.toResponse(reply),
      rechecked: isRecord(reply) && reply.rechecked === true,
    };
  }

  private async ask(pattern: object, timeoutMs: number): Promise<unknown> {
    try {
      return await firstValueFrom(
        this.notificationClient.send(pattern, {}).pipe(timeout(timeoutMs)),
      );
    } catch (error) {
      const kind = error instanceof TimeoutError ? 'timeout' : 'down';
      // Xom sabab faqat server logida.
      this.logger.warn(
        `notification-bot health (${JSON.stringify(pattern)}): ${kind} — ${describeRpcError(error)}`,
      );
      throw new ServiceUnavailableException(BOT_HEALTH_UNAVAILABLE_TEXT[kind]);
    }
  }

  private toResponse(reply: unknown): NotificationBotHealthResponseDto {
    if (!isRecord(reply) || !isRecord(reply.bot)) {
      this.logger.warn('notification-bot health: kutilmagan javob shakli');
      throw new ServiceUnavailableException(BOT_HEALTH_UNAVAILABLE_TEXT.down);
    }
    return {
      status: reply.status === 'degraded' ? 'degraded' : 'ok',
      bot: toBotDiagnostics(reply.bot),
      timestamp:
        typeof reply.timestamp === 'string'
          ? reply.timestamp
          : new Date().toISOString(),
    };
  }
}
