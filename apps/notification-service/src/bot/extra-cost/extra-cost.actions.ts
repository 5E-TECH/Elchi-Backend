import { Injectable, Logger } from '@nestjs/common';
import {
  EXTRA_COST_REJECT_REASON_LABELS,
  ExtraCostRejectReason,
} from '@app/common';
import type { TelegramBotAction } from '../../entities/telegram-bot-action.entity';
import { BotActionsService } from '../bot-actions.service';
import { BotGatewayClient } from '../bot-gateway.client';
import { BotTransportService } from '../bot-transport.service';
import type { BotActionHandler, BotContext } from '../handlers/bot-context';
import type { InlineKeyboardButton } from '../telegram.types';

export const EXTRA_COST_ACTIONS = {
  approve: 'ec.ok',
  reject: 'ec.no',
  rejectReason: 'ec.rej',
  back: 'ec.back',
} as const;

export const EC_ONLY_OWNER_TEXT =
  "🔒 Qo'shimcha xarajatni faqat market egasi tasdiqlaydi.";
export const EC_ALREADY_DONE_TEXT = "ℹ️ Bu so'rov allaqachon yakunlangan.";

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const messageOf = (body: unknown): string => {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
};

/**
 * (DuST9k8j / 1tnpaIqd) Market egasining DM'idagi ✅ / ❌ tugmalari.
 * Qaror MAVJUD endpointlarga market JWT'si bilan (`POST
 * /orders/extra-cost-approvals/:id/approve|reject`); atomiklik serverda —
 * ikki marta bosish / panel bilan bir vaqtda qaror → "allaqachon
 * yakunlangan". Qarordan keyin asl xabar tugmalari olib tashlanadi.
 * Rad etish sababi — YOPIQ ro'yxat (ExtraCostRejectReason).
 */
@Injectable()
export class ExtraCostActions {
  private readonly logger = new Logger(ExtraCostActions.name);
  readonly handlers: BotActionHandler[];

  constructor(
    private readonly gateway: BotGatewayClient,
    private readonly actions: BotActionsService,
    private readonly transport: BotTransportService,
  ) {
    this.handlers = [
      {
        action: EXTRA_COST_ACTIONS.approve,
        foreignText: EC_ONLY_OWNER_TEXT,
        handle: (ctx, action) => this.decide(ctx, action, 'approve', null),
      },
      {
        action: EXTRA_COST_ACTIONS.reject,
        foreignText: EC_ONLY_OWNER_TEXT,
        handle: (ctx, action) => this.askReason(ctx, action),
      },
      {
        action: EXTRA_COST_ACTIONS.rejectReason,
        foreignText: EC_ONLY_OWNER_TEXT,
        handle: (ctx, action) =>
          this.decide(ctx, action, 'reject', str(action.payload.reason)),
      },
      {
        action: EXTRA_COST_ACTIONS.back,
        foreignText: EC_ONLY_OWNER_TEXT,
        handle: (ctx) =>
          ctx.reply('⬅️ Qaror keyinga qoldirildi.').then(() => undefined),
      },
    ];
  }

  private async askReason(ctx: BotContext, action: TelegramBotAction) {
    const approvalId = str(action.payload.approval_id);
    const actor = await ctx.actor();
    if (!approvalId || !actor) return;
    const rows: InlineKeyboardButton[][] = [];
    for (const reason of Object.values(ExtraCostRejectReason)) {
      rows.push([
        {
          text: EXTRA_COST_REJECT_REASON_LABELS[reason],
          callback_data: await this.actions.create({
            chatId: ctx.chatId,
            action: EXTRA_COST_ACTIONS.rejectReason,
            actorUserId: actor.user_id,
            orderId: action.order_id ? String(action.order_id) : null,
            payload: {
              approval_id: approvalId,
              reason,
              msg: action.message_id ? String(action.message_id) : null,
            },
            oneShot: false,
          }),
        },
      ]);
    }
    rows.push([
      {
        text: '⬅️ Orqaga',
        callback_data: await this.actions.create({
          chatId: ctx.chatId,
          action: EXTRA_COST_ACTIONS.back,
          actorUserId: actor.user_id,
          payload: {},
          oneShot: false,
        }),
      },
    ]);
    await ctx.reply('❌ Rad etish sababini tanlang:', {
      reply_markup: { inline_keyboard: rows },
    });
  }

  private async decide(
    ctx: BotContext,
    action: TelegramBotAction,
    decision: 'approve' | 'reject',
    reason: string | null,
  ) {
    const approvalId = str(action.payload.approval_id);
    if (!approvalId || !ctx.fromId) return;
    if (
      decision === 'reject' &&
      !(Object.values(ExtraCostRejectReason) as string[]).includes(reason ?? '')
    ) {
      return;
    }
    // Asl (tugmali) xabar: approve — shu tugma xabari; reject — sabab
    // tugmasi payload'idagi `msg`.
    const originalMessage =
      decision === 'approve'
        ? str(action.message_id)
        : str(action.payload.msg) || null;
    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request(
        ctx.fromId,
        'POST',
        `/orders/extra-cost-approvals/${encodeURIComponent(approvalId)}/${decision}`,
        decision === 'reject' ? { reason } : {},
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      this.logger.warn(
        `extra-cost ${decision} #${approvalId}: ${error instanceof Error ? error.message : 'error'}`,
      );
      await ctx.reply(
        "❌ Qaror yuborilmadi (aloqa xatosi) — qayta urinib ko'ring.",
      );
      return;
    }
    const text = messageOf(res.body);
    if (res.status >= 200 && res.status < 300) {
      await this.clearButtons(ctx, originalMessage);
      await ctx.reply(
        decision === 'approve'
          ? `✅ Qo'shimcha xarajat tasdiqlandi${action.order_id ? ` (buyurtma #${String(action.order_id)})` : ''}.`
          : `❌ Rad etildi: ${EXTRA_COST_REJECT_REASON_LABELS[reason as ExtraCostRejectReason]}.`,
      );
      return;
    }
    if (/allaqachon yakunlangan/i.test(text)) {
      await this.clearButtons(ctx, originalMessage);
      await ctx.reply(EC_ALREADY_DONE_TEXT);
      return;
    }
    if (res.status === 403) {
      await ctx.reply(EC_ONLY_OWNER_TEXT);
      return;
    }
    await ctx.reply(
      `❌ Qaror qabul qilinmadi${text ? `: ${text.slice(0, 200)}` : '.'}`,
    );
  }

  /** (1tnpaIqd #4) Qarordan keyin eskirgan tugma chatda qolmasin. */
  private async clearButtons(ctx: BotContext, messageId: string | null) {
    if (!messageId) return;
    await this.transport.editMessage(ctx.chatId, messageId, {
      reply_markup: { inline_keyboard: [] },
    });
  }
}
