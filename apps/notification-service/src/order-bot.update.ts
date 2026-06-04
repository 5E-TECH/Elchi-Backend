import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

/**
 * Order-create Telegram bot (PCS `order_create-bot` parity).
 *
 * A SEPARATE bot from the notification bot — it runs on its own ORDER_BOT_TOKEN
 * and lets a market operator:
 *   1. authenticate with their market token (`group_token-…`),
 *   2. open the order-creation WebApp (mini-app) that posts to the existing
 *      `orders/telegram/bot/create` endpoint,
 *   3. query an order's status by id.
 *
 * Like the notification bot this uses raw long-polling (getUpdates) rather than
 * pulling in the telegraf dependency. If ORDER_BOT_TOKEN is unset the listener
 * stays disabled, so the service boots fine without the bot configured.
 */

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramChat {
  id: number | string;
  type?: string;
}

interface TelegramMessage {
  message_id?: number;
  chat?: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface LinkedMarket {
  id: string;
  name: string;
  token: string;
}

const STATUS_EMOJI: Record<string, string> = {
  created: '🟡',
  new: '🟢',
  received: '📦',
  'on the road': '🚚',
  waiting: '⏳',
  waiting_customer: '🕓',
  sold: '✅',
  cancelled: '❌',
  'cancelled (sent)': '❌',
  returned_to_market: '↩️',
  paid: '💰',
  partly_paid: '💸',
  closed: '🔒',
};

const TOKEN_RE = /^group_token-[a-z0-9]{14,64}$/i;

@Injectable()
export class OrderBotUpdateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderBotUpdateService.name);
  private readonly token: string;
  private readonly webAppUrl: string;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  // chatId -> linked market. In-memory: a restart simply asks the operator to
  // re-send their token. The WebApp re-authenticates with the token anyway.
  private readonly links = new Map<string, LinkedMarket>();

  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {
    this.token = process.env.ORDER_BOT_TOKEN ?? '';
    this.webAppUrl = process.env.ORDER_BOT_WEBAPP_URL ?? '';
  }

  onModuleInit() {
    if (!this.token) {
      this.logger.warn(
        'ORDER_BOT_TOKEN is not set. Order-create bot is disabled.',
      );
      return;
    }
    this.running = true;
    void this.pollLoop();
    this.logger.log('Order-create bot listener started (long polling)');
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
    this.timer = setTimeout(() => void this.pollLoop(), delayMs);
  }

  private async pollLoop() {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=25&allowed_updates=["message","callback_query"]`,
      );
      if (!response.ok) {
        this.logger.error(`getUpdates failed: HTTP ${response.status}`);
        this.scheduleNext(3000);
        return;
      }
      const body = (await response.json()) as TelegramApiResponse<
        TelegramUpdate[]
      >;
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
      this.logger.error(
        error instanceof Error ? error.message : 'polling error',
      );
      this.scheduleNext(3000);
    }
  }

  private async processUpdate(update: TelegramUpdate) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const text = update.message?.text?.trim();
    const chatId = update.message?.chat?.id;
    if (!text || chatId === undefined || chatId === null) {
      return;
    }
    const chat = String(chatId);

    if (text === '/start' || text === '/help') {
      const linked = this.links.get(chat);
      if (linked) {
        await this.sendStartButtons(chat, linked);
      } else {
        await this.sendMessage(
          chat,
          '🛍️ <b>Buyurtma yaratish boti</b>\n\nBoshlash uchun market tokeningizni yuboring (masalan: <code>group_token-…</code>).\n\nTokenni admin panelidan olishingiz mumkin.',
        );
      }
      return;
    }

    if (TOKEN_RE.test(text)) {
      await this.handleToken(chat, text);
      return;
    }

    // "/status 123" or "status 123"
    const statusMatch = text.match(/^\/?status\s+(\d+)$/i);
    if (statusMatch) {
      await this.replyOrderStatus(chat, statusMatch[1]);
      return;
    }

    await this.sendMessage(
      chat,
      'Tushunarsiz buyruq. Market tokeningizni yuboring yoki <code>/status &lt;buyurtma raqami&gt;</code> deb yozing.',
    );
  }

  private async handleToken(chat: string, token: string) {
    try {
      const res = await rmqSend<{
        data?: { id: string; name?: string };
      }>(
        this.identityClient,
        { cmd: 'identity.market.find_by_tg_token' },
        { market_tg_token: token },
      );
      const market = res?.data;
      if (!market?.id) {
        await this.sendMessage(
          chat,
          "❌ Token noto'g'ri yoki market topilmadi.",
        );
        return;
      }
      const linked: LinkedMarket = {
        id: String(market.id),
        name: market.name ?? 'Market',
        token,
      };
      this.links.set(chat, linked);
      await this.sendStartButtons(chat, linked, true);
    } catch (error) {
      await this.sendMessage(
        chat,
        `❌ ${error instanceof Error ? error.message : 'Token tekshirishda xatolik.'}`,
      );
    }
  }

  private async sendStartButtons(
    chat: string,
    market: LinkedMarket,
    justLinked = false,
  ) {
    const greeting = justLinked
      ? `✅ <b>${this.escape(market.name)}</b> ulandi.`
      : `👋 <b>${this.escape(market.name)}</b>`;

    if (this.webAppUrl) {
      const url = `${this.webAppUrl}${this.webAppUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(market.token)}`;
      await this.sendMessage(
        chat,
        `${greeting}\n\nBuyurtma yaratish uchun quyidagi tugmani bosing:`,
        {
          inline_keyboard: [
            [{ text: '🛍️ Buyurtma yaratish', web_app: { url } }],
          ],
        },
      );
    } else {
      // No WebApp configured — still useful: the operator is authenticated and
      // can query order status. Surfacing this avoids a silent dead-end.
      await this.sendMessage(
        chat,
        `${greeting}\n\nBuyurtma holatini bilish uchun: <code>/status &lt;buyurtma raqami&gt;</code>`,
      );
    }
  }

  private async handleCallback(cb: TelegramCallbackQuery) {
    const chat = cb.message?.chat?.id;
    await this.answerCallback(cb.id);
    if (chat === undefined || chat === null) return;
    const [action, orderId] = (cb.data ?? '').split(':');
    if (action === 'status' && orderId) {
      await this.replyOrderStatus(String(chat), orderId);
    }
  }

  private async replyOrderStatus(chat: string, orderId: string) {
    try {
      const res = await rmqSend<{
        data?: { id: string; status?: string; total_price?: number };
      }>(this.orderClient, { cmd: 'order.find_by_id' }, { id: orderId });
      const order = res?.data;
      if (!order?.id) {
        await this.sendMessage(chat, `❌ #${orderId} buyurtma topilmadi.`);
        return;
      }
      const status = String(order.status ?? '');
      const emoji = STATUS_EMOJI[status] ?? '•';
      await this.sendMessage(
        chat,
        `${emoji} Buyurtma <b>#${this.escape(String(order.id))}</b>\nHolati: <b>${this.escape(status)}</b>`,
      );
    } catch (error) {
      await this.sendMessage(
        chat,
        `❌ ${error instanceof Error ? error.message : 'Buyurtmani olishda xatolik.'}`,
      );
    }
  }

  // ===== Telegram Bot API helpers =====

  private async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: { inline_keyboard: unknown[][] },
  ) {
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        }),
      });
    } catch (error) {
      this.logger.error(
        `sendMessage failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async answerCallback(callbackQueryId: string) {
    try {
      await fetch(
        `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQueryId }),
        },
      );
    } catch {
      // best-effort — the callback just won't get its loading spinner cleared
    }
  }

  private escape(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
