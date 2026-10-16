import { Injectable, Logger } from '@nestjs/common';
import type { TelegramBotAction } from '../../entities/telegram-bot-action.entity';
import { BotGatewayClient } from '../bot-gateway.client';
import { BotTransportService } from '../bot-transport.service';
import type { BotActionHandler, BotContext } from '../handlers/bot-context';

/** Kvitansiya tugmalari — finance-service `data.telegram_buttons` da shu nomlar. */
export const PAYMENT_ACK_ACTIONS = {
  confirm: 'fp.ok',
  dispute: 'fp.no',
} as const;

export const PAYMENT_ACK_FOREIGN_TEXT =
  '🔒 Bu kvitansiya faqat pulni topshirgan kuryerga tegishli.';
export const PAYMENT_ACK_CONFIRMED_TEXT = '👍 Tasdiqlandi. Rahmat!';
export const PAYMENT_ACK_DISPUTED_TEXT =
  "❗️ E'tirozingiz qabul qilindi — menejer va filial boshlig'iga yuborildi. Kassa qoldig'i o'zgarmadi.";
export const PAYMENT_ACK_ALREADY_TEXT =
  'ℹ️ Bu kvitansiyaga allaqachon javob berilgan.';

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/**
 * (2crjWf7v #3-#4) Kuryer kvitansiyasidagi "👍 Tasdiqlayman" / "❗️ Noto'g'ri".
 *
 * TUGMALAR KASSAGA TA'SIR QILMAYDI: bot faqat mavjud gateway endpointini
 * (`POST /finance/cashbox/payment/courier/:id/ack`) kuryerning O'Z JWT'si
 * bilan chaqiradi — finance-service faqat `courier_payment_acks` ga audit
 * yozuvi qo'shadi (bir kvitansiyaga bitta). Pul yozuvi hech qachon yaratilmaydi.
 * Faqat shaxsiy chat (kvitansiya guruhga hech qachon yuborilmaydi).
 */
@Injectable()
export class PaymentAckActions {
  private readonly logger = new Logger(PaymentAckActions.name);
  readonly handlers: BotActionHandler[];

  constructor(
    private readonly gateway: BotGatewayClient,
    private readonly transport: BotTransportService,
  ) {
    this.handlers = [
      {
        action: PAYMENT_ACK_ACTIONS.confirm,
        foreignText: PAYMENT_ACK_FOREIGN_TEXT,
        handle: (ctx, action) => this.ack(ctx, action, 'confirmed'),
      },
      {
        action: PAYMENT_ACK_ACTIONS.dispute,
        foreignText: PAYMENT_ACK_FOREIGN_TEXT,
        handle: (ctx, action) => this.ack(ctx, action, 'disputed'),
      },
    ];
  }

  private async ack(
    ctx: BotContext,
    action: TelegramBotAction,
    ack: 'confirmed' | 'disputed',
  ) {
    const paymentId = str(action.payload.payment_id);
    if (!/^\d{1,20}$/.test(paymentId) || !ctx.fromId) return;
    if (!ctx.isPrivate) {
      await ctx.reply(PAYMENT_ACK_FOREIGN_TEXT);
      return;
    }
    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request(
        ctx.fromId,
        'POST',
        `/finance/cashbox/payment/courier/${paymentId}/ack`,
        { ack },
      );
    } catch (error) {
      this.logger.warn(
        `kvitansiya #${paymentId} (${ack}): ${error instanceof Error ? error.message : 'error'}`,
      );
      await ctx.reply(
        "❌ Javob yuborilmadi (aloqa xatosi) — qayta urinib ko'ring.",
      );
      return;
    }
    const data = (res.body as { data?: { already?: unknown } } | null)?.data;
    if (res.status >= 200 && res.status < 300) {
      await this.clearButtons(ctx, action);
      await ctx.reply(
        data?.already === true
          ? PAYMENT_ACK_ALREADY_TEXT
          : ack === 'confirmed'
            ? PAYMENT_ACK_CONFIRMED_TEXT
            : PAYMENT_ACK_DISPUTED_TEXT,
      );
      return;
    }
    if (res.status === 403 || res.status === 404) {
      await ctx.reply(PAYMENT_ACK_FOREIGN_TEXT);
      return;
    }
    await ctx.reply(
      "❌ Javob qabul qilinmadi — keyinroq qayta urinib ko'ring.",
    );
  }

  /** Javobdan keyin kvitansiyadagi tugmalar olib tashlanadi. */
  private async clearButtons(ctx: BotContext, action: TelegramBotAction) {
    const messageId = str(action.message_id);
    if (!messageId) return;
    await this.transport.editMessage(ctx.chatId, messageId, {
      reply_markup: { inline_keyboard: [] },
    });
  }
}
