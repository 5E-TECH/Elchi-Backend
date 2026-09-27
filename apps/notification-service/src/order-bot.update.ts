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
 *
 * PER-CHAT NAVBAT (Gy8Lt6KT, BeePost `enqueueAi` namunasi): pollLoop update'ni
 * faqat o'z chatining navbatiga qo'yadi va DARHOL keyingisiga o'tadi. Bitta
 * chatning sekin ishi (masalan 15 s) boshqa chatlarni bloklamaydi; bitta chat
 * ichida esa xabarlar kelgan tartibda birma-bir bajariladi.
 *
 * ⚠️ FAQAT BITTA REPLIKA. Telegram getUpdates bir token uchun bitta
 * polling'ga ruxsat beradi: ikkinchi replika (yoki bir xil ORDER_BOT_TOKEN
 * bilan ishlayotgan boshqa muhit) HTTP 409 Conflict oladi va bot jim qoladi.
 * notification-service'ni scale qilmang (yoki avval webhook'ga o'ting).
 */

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramChat {
  id: number | string;
  type?: string;
}

interface TelegramUser {
  id: number | string;
}

interface TelegramMessage {
  message_id?: number;
  chat?: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: TelegramUser;
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

// Navbat to'lganda foydalanuvchiga boradigan javob (Gy8Lt6KT #10): xabar
// JIMGINA tashlanmaydi, operator nima bo'lganini ko'radi.
const CHAT_QUEUE_FULL_TEXT =
  "⏳ Juda ko'p xabar navbatda. Avvalgilarini o'qib bo'lay, biroz kuting.";

// Chat aniqlanmagan update'lar (amalda uchramaydi: allowed_updates faqat
// message/callback_query, callback_query'da esa `from` doim bor) umumiy
// navbatga tushadi — processUpdate ularni o'zi jimgina o'tkazib yuboradi.
const NO_CHAT_QUEUE_KEY = '__no_chat__';

// onModuleDestroy navbatdagi ishlarni ko'pi bilan shuncha kutadi. Docker
// stop_grace_period (sukut 10 s) dan KICHIK bo'lishi shart, aks holda SIGKILL.
const QUEUE_DRAIN_TIMEOUT_MS = 8_000;

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

  // Chat bo'yicha KETMA-KET NAVBAT (Gy8Lt6KT, BeePost order-bot.update.ts
  // `aiQueues`/`aiPending`). chatQueues: chat -> oxirgi ish promise'i (zanjir
  // dumi). chatPending: shu chatda bajarilayotgan + kutayotgan ishlar soni
  // (navbat cheklovi uchun).
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly chatPending = new Map<string, number>();
  private static readonly MAX_QUEUE = 12;

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

  async onModuleDestroy(): Promise<void> {
    // 1) Polling to'xtaydi: yangi getUpdates rejalashtirilmaydi, uchib
    //    ketayotgan so'rov natijasi esa navbatga qo'yilmaydi (pollLoop).
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 2) Navbatdagi ishlar tugashini kutamiz, lekin ko'pi bilan 8 s. Har chat
    //    uchun faqat zanjir DUMI saqlanadi — u tugasa o'sha chatning barcha
    //    avvalgi ishlari ham tugagan bo'ladi.
    const pending = [...this.chatQueues.values()];
    if (pending.length === 0) return;
    let capTimer: NodeJS.Timeout | undefined;
    const cap = new Promise<'timeout'>((resolve) => {
      capTimer = setTimeout(() => resolve('timeout'), QUEUE_DRAIN_TIMEOUT_MS);
    });
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => 'drained' as const),
      cap,
    ]);
    if (capTimer) clearTimeout(capTimer);
    if (outcome === 'timeout') {
      this.logger.warn(
        `Order bot shutdown: ${this.chatQueues.size} chat queue(s) still busy after ${QUEUE_DRAIN_TIMEOUT_MS}ms, not waiting any longer`,
      );
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
        // Long-poll: Telegram holds up to 25s; bound the client a bit above that
        // so a stalled socket can't freeze the poll loop (bot goes silent).
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) {
        // ⚠️ 409 = shu token bilan BOSHQA instance ham polling qilyapti (ikkinchi
        // replika). Bot shu holatda jim qoladi — sababini logda aniq ko'rsatamiz.
        this.logger.error(
          response.status === 409
            ? 'getUpdates failed: HTTP 409 Conflict (another instance is polling this ORDER_BOT_TOKEN; the order bot must run on a single replica)'
            : `getUpdates failed: HTTP ${response.status}`,
        );
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
      // ⚠️ Servis to'xtatilayotgan bo'lsa (onModuleDestroy) yangi ish QABUL
      // QILINMAYDI: bu update'lar keyingi getUpdates offset'i bilan
      // tasdiqlanmagan, shuning uchun Telegram ularni keyingi ishga tushishda
      // qayta beradi. Aks holda ular drain'dan keyin navbatga tushib yo'qolardi.
      if (!this.running) return;
      for (const update of body.result ?? []) {
        // Offset NAVBATGA QO'YISHDA oshiriladi, ishlov berish esa navbatda
        // (processWithRetry: bir marta qayta urinish). Sof "ishlovdan keyin
        // ko'chirish" poison-message'da cheksiz sikl beradi (Gy8Lt6KT #9).
        this.offset = update.update_id + 1;
        this.dispatchUpdate(update);
      }
      this.scheduleNext(200);
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'polling error',
      );
      this.scheduleNext(3000);
    }
  }

  // ===== Per-chat queue (Gy8Lt6KT) =====

  /**
   * Update'ni o'z chatining navbatiga qo'yadi va DARHOL qaytadi — pollLoop
   * ishlov berishni hech qachon kutmaydi (Gy8Lt6KT #8). Navbat to'lgan bo'lsa
   * foydalanuvchiga javob yuboriladi (#10).
   */
  private dispatchUpdate(update: TelegramUpdate): void {
    const chatId = this.chatIdOf(update);
    const accepted = this.enqueueChat(chatId ?? NO_CHAT_QUEUE_KEY, () =>
      this.processWithRetry(update),
    );
    if (accepted) return;
    this.logger.warn(
      `Chat queue is full (${OrderBotUpdateService.MAX_QUEUE}); update ${update.update_id} rejected with a "queue full" reply`,
    );
    // sendMessage o'z xatolarini o'zi ushlaydi; pollLoop'ni to'sib qo'ymaslik
    // uchun kutmaymiz.
    if (chatId !== null) void this.sendMessage(chatId, CHAT_QUEUE_FULL_TEXT);
  }

  // message.chat.id, bo'lmasa callback_query.message.chat.id / from.id.
  private chatIdOf(update: TelegramUpdate): string | null {
    const id =
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      update.callback_query?.from?.id;
    return id === undefined || id === null ? null : String(id);
  }

  /**
   * Ishni chat navbatiga qo'shadi (avvalgisi tugagach bajariladi). Navbat
   * to'lgan bo'lsa false qaytaradi — chaqiruvchi foydalanuvchini ogohlantiradi.
   * Ish xato bersa (sync throw ham) zanjir BUZILMAYDI: `.catch` log qiladi,
   * keyingi ishlar baribir bajariladi (#11). `.finally` xaritalarni tozalaydi.
   */
  private enqueueChat(chatId: string, task: () => Promise<void>): boolean {
    const pending = this.chatPending.get(chatId) ?? 0;
    if (pending >= OrderBotUpdateService.MAX_QUEUE) return false;
    this.chatPending.set(chatId, pending + 1);
    const prev = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => task())
      .catch((error: unknown) => {
        this.logger.error(
          `Chat queue task failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        const left = (this.chatPending.get(chatId) ?? 1) - 1;
        if (left <= 0) {
          this.chatPending.delete(chatId);
          if (this.chatQueues.get(chatId) === next) {
            this.chatQueues.delete(chatId);
          }
        } else {
          this.chatPending.set(chatId, left);
        }
      });
    this.chatQueues.set(chatId, next);
    return true;
  }

  /**
   * processUpdate'ni bajaradi; throw bo'lsa BIR MARTA qayta urinadi (#9).
   * Ikkinchi xatoda ERROR log qilinadi va update tashlab ketiladi — offset
   * allaqachon oshgan, shuning uchun poison-message cheksiz aylanmaydi. Bu
   * metod hech qachon throw qilmaydi.
   */
  private async processWithRetry(update: TelegramUpdate): Promise<void> {
    try {
      await this.processUpdate(update);
      return;
    } catch (error) {
      this.logger.warn(
        `Update ${update.update_id} failed, retrying once: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await this.processUpdate(update);
    } catch (error) {
      this.logger.error(
        `Update ${update.update_id} failed twice, dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
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
        signal: AbortSignal.timeout(10_000),
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
          signal: AbortSignal.timeout(10_000),
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
