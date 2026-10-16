import { Injectable } from '@nestjs/common';
import { NotificationServiceService } from '../../notification-service.service';
import { BotRateLimiterService } from '../bot-rate-limiter.service';
import type { BotContext, BotMessageHandler } from './bot-context';
import {
  HELP_COMMAND_RE,
  LINK_BLOCKED_TEXT,
  START_COMMAND_RE,
} from './start.handler';

export const GROUP_START_TEXT =
  "Salom. Guruhni ulash uchun admin bergan maxfiy market tokenini (group_token-…) yuboring. Bekor qilingan buyurtmalar guruhi uchun token oxiriga -cancel qo'shing.";
export const GROUP_HELP_TEXT =
  'Mavjud komandalar: /start, /help, /id (guruh ID si). Ulanish uchun: admin bergan maxfiy market tokeni (group_token-…); bekor qilinganlar guruhi uchun <token>-cancel. Ulangan guruhni almashtirish faqat admin orqali.';

const GROUP_TOKEN_TEXT_RE = /^group_token-.+/i;

/**
 * Guruh chati (eski notification-bot): `/start`, `/help`, maxfiy market
 * tokeni bilan ulash. Guruh — KO'RINISH joyi: bu yerda faqat ulash, huquq
 * talab qiladigan buyruq yo'q.
 */
@Injectable()
export class GroupHandler implements BotMessageHandler {
  constructor(
    private readonly notifications: NotificationServiceService,
    private readonly limiter: BotRateLimiterService,
  ) {}

  async handle(ctx: BotContext): Promise<boolean> {
    if (ctx.isPrivate || !ctx.text) return false;

    if (START_COMMAND_RE.test(ctx.text)) {
      await ctx.reply(GROUP_START_TEXT);
      return true;
    }
    if (HELP_COMMAND_RE.test(ctx.text)) {
      await ctx.reply(GROUP_HELP_TEXT);
      return true;
    }
    if (GROUP_TOKEN_TEXT_RE.test(ctx.text)) {
      // (GL2GgtEc #1) bog'lash kodi urinishlari — odam bo'yicha 5/daqiqa.
      const decision = await this.limiter.linkAttempt(ctx.fromId ?? ctx.chatId);
      if (!decision.allowed) {
        if (decision.hits === 6) await ctx.reply(LINK_BLOCKED_TEXT);
        return true;
      }
      const result = await this.notifications.connectGroupByTokenText(
        ctx.text,
        ctx.chatId,
      );
      await ctx.reply(result.message);
      return true;
    }
    return false;
  }
}
