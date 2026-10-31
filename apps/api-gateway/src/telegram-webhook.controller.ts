import { TELEGRAM_UPDATE_EVENT } from '@app/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { firstValueFrom, timeout } from 'rxjs';
import { Public } from './auth/public.decorator';

/** notification-service `BotController` shu hodisani tinglaydi (yagona manba — libs/common). */
export { TELEGRAM_UPDATE_EVENT };
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SLUG_RE = /^[a-z0-9_-]{1,32}$/;
/** (BOT-3d) RMQ'ga uzatish chegarasi — Telegram webhook javobini kutadi. */
export const TELEGRAM_EMIT_TIMEOUT_MS = 3_000;

/**
 * Doimiy vaqtli solishtirish. Ikkala qiymat SHA-256 bilan bir xil uzunlikka
 * keltiriladi — uzunlik farqi ham vaqt orqali sizib chiqmaydi. Oddiy `===`
 * ISHLATILMAYDI (uCrzrElu #2).
 */
export function secretMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * (uCrzrElu) Telegram webhook: `POST /telegram/webhook/:botSlug`.
 *
 * - `@Public()` — JWT yo'q; YAGONA himoya `X-Telegram-Bot-Api-Secret-Token`
 *   (setWebhook `secret_token`), `TELEGRAM_WEBHOOK_SECRET` bilan
 *   `timingSafeEqual`. Mos kelmasa yoki server sekreti sozlanmagan bo'lsa —
 *   401 + log, RMQ'ga HECH NIMA uzatilmaydi.
 * - Gateway faqat o'tkazgich: update RMQ HODISASI (`emit`) bo'lib
 *   notification-service'ga ketadi; ishlov kutilmaydi, lekin brokerga
 *   UZATILISHI kutiladi (BOT-3d): RMQ xatosi / ${TELEGRAM_EMIT_TIMEOUT_MS} ms
 *   timeout → 503, Telegram update'ni keyin qayta yuboradi (avval 200
 *   qaytib update jim yo'qolardi).
 * - IP-throttle o'chiq: hamma so'rov Telegram IP'laridan keladi; cheklov
 *   notification-service'da chat_id/from.id bo'yicha (GL2GgtEc).
 * - Noto'g'ri `botSlug` ham uzatiladi — router jim tashlaydi (ZlpXb4Wh).
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('telegram/webhook')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);
  private readonly secret: string;
  private missingSecretLogged = false;

  constructor(
    // (BOT-3a) alohida bot navbati — umumiy NOTIFICATION navbatidagi
    // dispatch to'lqini bot javobini kechiktirmaydi.
    @Inject('NOTIFICATION_BOT')
    private readonly notificationClient: ClientProxy,
    config: ConfigService,
  ) {
    const secret = String(config.get('TELEGRAM_WEBHOOK_SECRET') ?? '').trim();
    this.secret = SECRET_RE.test(secret) ? secret : '';
  }

  @Public()
  @Post(':botSlug')
  @HttpCode(200)
  async receive(
    @Param('botSlug') botSlug: string,
    @Headers(TELEGRAM_SECRET_HEADER) secretHeader: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    if (!this.secret) {
      if (!this.missingSecretLogged) {
        this.missingSecretLogged = true;
        this.logger.warn(
          'TELEGRAM_WEBHOOK_SECRET sozlanmagan — Telegram webhook yopiq (401)',
        );
      }
      throw new UnauthorizedException();
    }
    if (!secretMatches(secretHeader, this.secret)) {
      this.logger.warn(
        `Telegram webhook: noto'g'ri secret_token (ip=${req.ip ?? '?'}) — rad etildi`,
      );
      throw new UnauthorizedException();
    }
    const slug = String(botSlug ?? '').toLowerCase();
    const update = req.body as { update_id?: unknown } | undefined;
    if (
      !SLUG_RE.test(slug) ||
      !update ||
      typeof update !== 'object' ||
      !Number.isSafeInteger(update.update_id)
    ) {
      // Sekret to'g'ri, lekin tana yaroqsiz — 200 (Telegram qayta yubormasin).
      this.logger.warn("Telegram webhook: yaroqsiz update — e'tiborsiz");
      return { ok: true };
    }
    // `emit` — ishlov kutilmaydi, lekin brokerga uzatilishi kutiladi: xato
    // bo'lsa 503 — Telegram qayta yuboradi (update yo'qolmaydi).
    try {
      await firstValueFrom(
        this.notificationClient
          .emit({ cmd: TELEGRAM_UPDATE_EVENT }, { bot_slug: slug, update })
          .pipe(timeout(TELEGRAM_EMIT_TIMEOUT_MS)),
        { defaultValue: undefined },
      );
    } catch (error) {
      this.logger.error(
        `Telegram update RMQ'ga uzatilmadi — 503 (Telegram qayta yuboradi): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException();
    }
    return { ok: true };
  }
}
