import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationServiceService } from './notification-service.service';

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id: number | string; type?: string };
    text?: string;
  };
}

@Injectable()
export class NotificationBotUpdateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationBotUpdateService.name);
  private readonly token: string;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly notificationService: NotificationServiceService) {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  }

  onModuleInit() {
    if (!this.token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set. Telegram listener is disabled.');
      return;
    }

    this.running = true;
    this.pollLoop();
    this.logger.log('Telegram bot listener started (long polling)');
  }

  onModuleDestroy() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs = 1000) {
    if (!this.running) return;
    this.timer = setTimeout(() => this.pollLoop(), delayMs);
  }

  private async pollLoop() {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=25`,
      );

      if (!response.ok) {
        this.logger.error(`getUpdates failed: HTTP ${response.status}`);
        this.scheduleNext(3000);
        return;
      }

      const body = (await response.json()) as TelegramApiResponse<TelegramUpdate[]>;
      if (!body?.ok) {
        this.logger.error('getUpdates returned ok=false');
        this.scheduleNext(3000);
        return;
      }

      for (const update of body.result ?? []) {
        this.offset = update.update_id + 1;
        await this.processUpdate(update);
      }

      this.scheduleNext(200);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'polling error');
      this.scheduleNext(3000);
    }
  }

  private async processUpdate(update: TelegramUpdate) {
    const text = update?.message?.text?.trim();
    const chatId = update?.message?.chat?.id;

    if (!text || chatId === undefined || chatId === null) {
      return;
    }

    const groupId = String(chatId);

    if (text === '/start') {
      await this.notificationService.sendDirectToGroup({
        group_id: groupId,
        message:
          "Salom. Guruhni ulash uchun 'group_token-<marketId>' yoki 'group_token-<marketId>-<group_type>' yuboring.",
      });
      return;
    }

    if (text === '/help') {
      await this.notificationService.sendDirectToGroup({
        group_id: groupId,
        message: 'Mavjud komandalar: /start, /help va group_token-*',
      });
      return;
    }

    if (/^group_token-.+/i.test(text)) {
      const result = await this.notificationService.connectGroupByTokenText(text, groupId);
      await this.notificationService.sendDirectToGroup({
        group_id: groupId,
        message: result.message,
      });
      return;
    }

    if (text.toLowerCase() === 'salom') {
      await this.notificationService.sendDirectToGroup({
        group_id: groupId,
        message: 'Valeykum assalom!',
      });
    }
  }
}
