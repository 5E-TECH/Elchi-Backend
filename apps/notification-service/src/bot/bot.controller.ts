import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { RmqService } from '@app/common';
import { TELEGRAM_UPDATE_EVENT } from './bot-config';
import { BotRateLimiterService } from './bot-rate-limiter.service';
import { BotRouterService } from './bot-router.service';
import { BotRuntimeService } from './bot-runtime.service';
import type { TelegramUpdate } from './telegram.types';

export interface TelegramUpdateEvent {
  bot_slug?: unknown;
  update?: TelegramUpdate;
}

/**
 * (uCrzrElu #3) Gateway webhook'i update'ni RMQ HODISASI qilib uzatadi va
 * Telegram'ga DARHOL 200 qaytaradi — ishlov shu yerda, asinxron.
 *
 * - Faqat webhook rejimida va token sog' bo'lsa qabul qilinadi (polling
 *   rejimida ikkinchi transport yo'q; buzuq token — bot ishga tushmagan).
 * - `update_id` bo'yicha takror (Telegram qayta yuborishi / RMQ qayta
 *   yetkazishi) bir marta ishlanadi.
 * - Hodisa ishlovdan KEYIN ack qilinadi; router hech qachon throw qilmaydi.
 */
@Controller()
export class BotController {
  private readonly logger = new Logger(BotController.name);

  constructor(
    private readonly rmqService: RmqService,
    private readonly runtime: BotRuntimeService,
    private readonly router: BotRouterService,
    private readonly limiter: BotRateLimiterService,
  ) {}

  @EventPattern({ cmd: TELEGRAM_UPDATE_EVENT })
  async onTelegramUpdate(
    @Payload() event: TelegramUpdateEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    try {
      await this.runtime.ready();
      if (!this.runtime.acceptsWebhook()) {
        this.logger.warn(
          `Telegram webhook update qabul qilinmadi: ${this.runtime.health().reason}`,
        );
        return;
      }
      const update = event?.update;
      if (!update || !Number.isSafeInteger(update.update_id)) return;
      if (!(await this.limiter.firstSeen(update.update_id))) return;
      await this.router.dispatch(
        typeof event.bot_slug === 'string' ? event.bot_slug : '',
        update,
      );
    } catch (error) {
      this.logger.error(
        `Telegram update ishlovi: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.rmqService.ack(context);
    }
  }
}
