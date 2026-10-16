import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Roles, escapeTelegramHtml, rmqSend } from '@app/common';
import type { BotContext, BotMessageHandler } from './bot-context';

export const STATUS_EMOJI: Record<string, string> = {
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

export const STATUS_COMMAND_RE = /^\/?status(?:@\w+)?\s+(\d{1,19})$/i;
export const STATUS_NOT_LINKED_TEXT =
  "🔒 Buyurtma holatini ko'rish uchun avval Telegram'ni Elchi akkauntingizga ulang (profil → «Telegram'ni ulash»).";
export const STATUS_ROLE_DENIED_TEXT =
  "🔒 /status buyrug'i faqat market va market operatori uchun.";
export const ORDER_LOOKUP_FAILED_TEXT =
  "❌ Buyurtmani olishda xatolik. Birozdan so'ng qayta urinib ko'ring.";
export const UNKNOWN_COMMAND_TEXT =
  'Tushunarsiz buyruq. Menyu: /start. Buyurtma holati: <code>/status &lt;buyurtma raqami&gt;</code>';

const MARKET_ROLES: readonly string[] = [Roles.MARKET, Roles.MARKET_OPERATOR];

/** Yo'q buyurtma va boshqa marketning buyurtmasi uchun BIR XIL javob. */
export const orderNotFoundText = (orderId: string) =>
  `❌ #${orderId} buyurtma topilmadi.`;

/**
 * `/status <id>` (eski order-bot) — CODE-18 / 3ZfiXuaW / Pq2dFj8A:
 *  - aktor yechilmasa (bog'lanmagan chat) — faqat "avval ulang", buyurtma
 *    ma'lumoti YO'Q (avval `/status` bog'lanishni tekshirmasdan ishlardi);
 *  - huquq ODAM bo'yicha (users.telegram_id), xotiradagi `links` Map emas —
 *    restartdan keyin qayta ulash so'ralmaydi;
 *  - market/market_operator faqat O'Z marketining buyurtmasini ko'radi;
 *    boshqa marketniki va yo'q buyurtma — bir xil "topilmadi".
 */
@Injectable()
export class MarketHandler implements BotMessageHandler {
  private readonly logger = new Logger(MarketHandler.name);

  constructor(@Inject('ORDER') private readonly orders: ClientProxy) {}

  async handle(ctx: BotContext): Promise<boolean> {
    const match = STATUS_COMMAND_RE.exec(ctx.text);
    if (!match) return false;
    const orderId = match[1];
    const actor = await ctx.actor();
    if (!actor) {
      await ctx.reply(STATUS_NOT_LINKED_TEXT);
      return true;
    }
    if (!MARKET_ROLES.includes(actor.role) || !actor.market_id) {
      await ctx.reply(STATUS_ROLE_DENIED_TEXT);
      return true;
    }
    try {
      const response = await rmqSend<unknown>(
        this.orders,
        { cmd: 'order.find_by_id' },
        { id: orderId },
      );
      const order = unwrapOrder(response);
      if (!order?.id || String(order.market_id ?? '') !== actor.market_id) {
        await ctx.reply(orderNotFoundText(orderId));
        return true;
      }
      const status = String(order.status ?? '');
      await ctx.reply(
        `${STATUS_EMOJI[status] ?? '•'} Buyurtma <b>#${escapeTelegramHtml(String(order.id))}</b>\nHolati: <b>${escapeTelegramHtml(status)}</b>`,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      if (rpcStatusOf(error) === 404) {
        await ctx.reply(orderNotFoundText(orderId));
        return true;
      }
      this.logger.warn(
        `Order status lookup failed for #${orderId}: ${describeError(error)}`,
      );
      await ctx.reply(ORDER_LOOKUP_FAILED_TEXT);
    }
    return true;
  }
}

/** order.find_by_id qatorni o'ramsiz qaytaradi; eski `{ data }` ham. */
export function unwrapOrder(response: unknown): {
  id?: string | number;
  status?: string;
  market_id?: string | number | null;
} | null {
  if (!response || typeof response !== 'object') return null;
  const wrapped = (response as { data?: unknown }).data;
  return (wrapped && typeof wrapped === 'object' ? wrapped : response) as {
    id?: string | number;
    status?: string;
    market_id?: string | number | null;
  };
}

/** Masofaviy RpcException holat kodi (RMQ orqali oddiy obyekt). */
export function rpcStatusOf(error: unknown): number | null {
  const source = error instanceof RpcException ? error.getError() : error;
  if (!source || typeof source !== 'object') return null;
  const status = Number((source as { statusCode?: unknown }).statusCode);
  return Number.isFinite(status) ? status : null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'unknown error';
}
