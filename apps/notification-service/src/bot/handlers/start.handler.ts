import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityLogService } from '@app/common';
import { TelegramDmService } from '../../telegram/telegram-dm.service';
import { BotRateLimiterService } from '../bot-rate-limiter.service';
import { Roles } from '@app/common';
import type { BotContext, BotMessageHandler } from './bot-context';

/**
 * `/id` yoki guruhdagi `/id@<bot_username>` — admin "Telegram guruhlari"
 * formasiga kerakli chat id (eski notification-bot, inventarizatsiya #1).
 */
export const GROUP_ID_COMMAND_RE = /^\/id(?:@\w+)?$/i;
/** (rCFZAmOz #1) `t.me/<bot>?start=<token>` → `/start <token>`. */
export const START_LINK_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})$/;
/** `/stop` (eski) va `/uzish` (3ZfiXuaW buyruq reyestri) — shaxsiy chatni uzish. */
export const UNLINK_COMMAND_RE = /^\/(?:stop|uzish)(?:@\w+)?$/i;
export const START_COMMAND_RE = /^\/start(?:@\w+)?$/i;
export const HELP_COMMAND_RE = /^\/help(?:@\w+)?$/i;

export const PRIVATE_ONLY_TEXT =
  'Shaxsiy bildirishnomalarni ulash faqat bot bilan SHAXSIY chatda ishlaydi.';
export const LINK_BLOCKED_TEXT =
  "⛔ Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.";
export const NOT_LINKED_TEXT =
  "👋 Elchi boti.\n\nTelegram'ni akkauntingizga ulash uchun Elchi profilingizda «Telegram'ni ulash» tugmasini bosing — havola sizni shu yerga qaytaradi.";

const MARKET_ROLES: readonly string[] = [Roles.MARKET, Roles.MARKET_OPERATOR];

/**
 * Shaxsiy chat buyruqlari (eski notification-bot + order-bot birlashmasi):
 * `/start <token>` (akkauntni ulash), `/stop`|`/uzish`, `/start`|`/help`
 * (aktor bo'yicha menyu), `/id`, `salom`.
 * Guruh buyruqlari — `GroupHandler`.
 */
@Injectable()
export class StartHandler implements BotMessageHandler {
  constructor(
    private readonly limiter: BotRateLimiterService,
    private readonly activityLog: ActivityLogService,
    private readonly config: ConfigService,
    @Optional() private readonly telegramDm?: TelegramDmService,
  ) {}

  async handle(ctx: BotContext): Promise<boolean> {
    const text = ctx.text;
    if (!text) return false;

    if (GROUP_ID_COMMAND_RE.test(text)) {
      await ctx.reply(`Group ID: ${ctx.chatId}`);
      return true;
    }

    const startLink = START_LINK_RE.exec(text);
    if (startLink || UNLINK_COMMAND_RE.test(text)) {
      if (!ctx.isPrivate) {
        await ctx.reply(PRIVATE_ONLY_TEXT);
        return true;
      }
      if (!this.telegramDm) return false;
      if (startLink) {
        // (GL2GgtEc #1) bog'lash kodi: odam bo'yicha 5/daqiqa → 15 daqiqa blok.
        const decision = await this.limiter.linkAttempt(
          ctx.fromId ?? ctx.chatId,
        );
        if (!decision.allowed) {
          if (decision.hits === 6) await ctx.reply(LINK_BLOCKED_TEXT);
          return true;
        }
        const result = await this.telegramDm.bindFromStart(
          startLink[1],
          ctx.chatId,
        );
        if (result.ok) {
          await this.activityLog.log({
            entity_type: 'TelegramChat',
            entity_id: ctx.chatId,
            action: 'notification.tg_linked',
            metadata: { via: 'start_link' },
          });
        }
        await ctx.reply(result.message);
        return true;
      }
      const result = await this.telegramDm.unbind(ctx.chatId);
      if (result.ok) {
        await this.activityLog.log({
          entity_type: 'TelegramChat',
          entity_id: ctx.chatId,
          action: 'notification.tg_unlinked',
          metadata: { via: 'command' },
        });
      }
      await ctx.reply(result.message);
      return true;
    }

    if (!ctx.isPrivate) return false;

    if (START_COMMAND_RE.test(text) || HELP_COMMAND_RE.test(text)) {
      await this.replyMenu(ctx);
      return true;
    }

    if (text.toLowerCase() === 'salom') {
      await ctx.reply('Valeykum assalom!');
      return true;
    }
    return false;
  }

  /** Aktor bo'yicha menyu; bog'lanmagan chat — faqat ulash ko'rsatmasi. */
  private async replyMenu(ctx: BotContext): Promise<void> {
    const actor = await ctx.actor();
    if (!actor) {
      await ctx.reply(NOT_LINKED_TEXT);
      return;
    }
    if (MARKET_ROLES.includes(actor.role)) {
      const webApp = String(
        this.config.get<string>('ORDER_BOT_WEBAPP_URL') ?? '',
      ).trim();
      const lines = [
        '🛍️ <b>Elchi — market</b>',
        '',
        'Buyurtma holati: <code>/status &lt;buyurtma raqami&gt;</code>',
        'Uzish: /uzish',
      ];
      await ctx.reply(
        lines.join('\n'),
        webApp
          ? {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🛍️ Buyurtma yaratish', web_app: { url: webApp } }],
                ],
              },
            }
          : { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.reply(
      '✅ Telegram akkauntingizga ulangan — Elchi bildirishnomalari shu chatga keladi.\n\nUzish: /uzish',
    );
  }
}
