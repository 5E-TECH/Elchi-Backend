import { Injectable } from '@nestjs/common';
import { NotificationServiceService } from '../../notification-service.service';
import { BotRateLimiterService } from '../bot-rate-limiter.service';
import type { BotContext, BotMessageHandler } from './bot-context';
import type { TelegramUser } from '../telegram.types';
import {
  HELP_COMMAND_RE,
  LINK_BLOCKED_TEXT,
  START_COMMAND_RE,
  START_LINK_RE,
} from './start.handler';

export const GROUP_START_TEXT =
  'Salom. Guruhni marketga ulash uchun Elchi kabinetidagi «Telegram guruhini ulash» havolasini oching va shu guruhni tanlang (havola bir martalik, 10 daqiqa amal qiladi). Bekor qilingan buyurtmalar guruhi uchun alohida havola oling.';
export const GROUP_HELP_TEXT =
  'Mavjud komandalar: /start, /help, /id (guruh ID si). Ulash — faqat kabinetdagi bir martalik havola orqali. Ulangan guruhni almashtirish faqat admin orqali.';
/** (6jXw0DDr #1-#3) matnli `group_token-…` bilan ulash olib tashlandi. */
export const GROUP_TOKEN_REMOVED_TEXT =
  "Matnli token bilan ulash o'chirildi. Elchi kabinetida «Telegram guruhini ulash» havolasini oching — u bir martalik va xavfsiz.";

const GROUP_TOKEN_TEXT_RE = /^group_token-.+/i;

/**
 * Guruh chati: `/start`, `/help`, bir martalik kod bilan ulash
 * (`t.me/<bot>?startgroup=<kod>` → `/start@bot <kod>`). Guruh — KO'RINISH
 * joyi: bu yerda faqat ulash, huquq talab qiladigan buyruq yo'q. Matnli
 * `group_token-…` endi ulamaydi (identity'ga so'rov ham ketmaydi).
 */
@Injectable()
export class GroupHandler implements BotMessageHandler {
  constructor(
    private readonly notifications: NotificationServiceService,
    private readonly limiter: BotRateLimiterService,
  ) {}

  async handle(ctx: BotContext): Promise<boolean> {
    if (ctx.isPrivate || !ctx.text) return false;

    const code = START_LINK_RE.exec(ctx.text);
    if (code) {
      // (GL2GgtEc #1) bog'lash kodi urinishlari — odam bo'yicha 5/daqiqa.
      const decision = await this.limiter.linkAttempt(ctx.fromId ?? ctx.chatId);
      if (!decision.allowed) {
        if (decision.hits === 6) await ctx.reply(LINK_BLOCKED_TEXT);
        return true;
      }
      const result = await this.notifications.connectGroupByCodeText(
        code[1],
        ctx.chatId,
      );
      await ctx.reply(result.message);
      return true;
    }
    if (START_COMMAND_RE.test(ctx.text)) {
      await ctx.reply(GROUP_START_TEXT);
      return true;
    }
    if (HELP_COMMAND_RE.test(ctx.text)) {
      await ctx.reply(GROUP_HELP_TEXT);
      return true;
    }
    if (GROUP_TOKEN_TEXT_RE.test(ctx.text)) {
      await ctx.reply(GROUP_TOKEN_REMOVED_TEXT);
      return true;
    }
    return false;
  }

  /**
   * (ysBqD9Nx DIQQAT) Guruh a'zoligi Elchi nazoratidan tashqarida: yangi
   * a'zo (odam) qo'shilsa — guruh egasi marketga ogohlantirish. Botning o'zi
   * (my_chat_member oqimi) va boshqa botlar hisobga olinmaydi. Javob
   * guruhga YOZILMAYDI.
   */
  async onNewMembers(ctx: BotContext, members: TelegramUser[]): Promise<void> {
    const humans = members.filter((member) => member && !member.is_bot);
    if (!humans.length) return;
    await this.notifications.warnGroupNewMembers(
      ctx.chatId,
      ctx.update.message?.chat?.title ?? null,
      humans,
    );
  }
}
