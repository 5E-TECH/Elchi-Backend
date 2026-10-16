import { Injectable } from '@nestjs/common';
import { Roles } from '@app/common';
import type { BotContext, BotMessageHandler } from './bot-context';

/**
 * (3ZfiXuaW #5) Buyruq reyestri rol bo'yicha va MINIMAL: umumiy `/start`,
 * `/help`, `/uzish`; kuryer `/ishim`, `/kun`, `/kassa`; market va uning
 * operatori `/status`, `/balans`. Qolgan hamma narsa — inline tugma.
 * Reyestrdagi buyruq:
 *  - guruhda — rad (guruh ko'rinish joyi, qaror/ma'lumot joyi emas);
 *  - bog'lanmagan chat — "avval ulang" (fail-closed, ma'lumot yo'q);
 *  - boshqa rol — rad.
 * O'tgan buyruq keyingi handlerga beriladi.
 */
export const ROLE_COMMANDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    status: [Roles.MARKET, Roles.MARKET_OPERATOR],
    balans: [Roles.MARKET, Roles.MARKET_OPERATOR],
    ishim: [Roles.COURIER],
    kun: [Roles.COURIER],
    kassa: [Roles.COURIER],
  });

export const COMMAND_GROUP_DENIED_TEXT =
  '🔒 Bu buyruq faqat bot bilan SHAXSIY chatda ishlaydi.';
export const COMMAND_NOT_LINKED_TEXT =
  "🔒 Avval Telegram'ni Elchi akkauntingizga ulang (kabinet → profil → «Telegram'ni ulash»).";
export const COMMAND_ROLE_DENIED_TEXT =
  '🔒 Bu buyruq sizning rolingiz uchun emas. Menyu: /start';

const COMMAND_RE = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i;

@Injectable()
export class CommandGateHandler implements BotMessageHandler {
  async handle(ctx: BotContext): Promise<boolean> {
    const match = COMMAND_RE.exec(ctx.text);
    const allowed = match ? ROLE_COMMANDS[match[1].toLowerCase()] : undefined;
    if (!allowed) return false;
    if (!ctx.isPrivate) {
      await ctx.reply(COMMAND_GROUP_DENIED_TEXT);
      return true;
    }
    const actor = await ctx.actor();
    if (!actor) {
      await ctx.reply(COMMAND_NOT_LINKED_TEXT);
      return true;
    }
    if (!allowed.includes(actor.role)) {
      await ctx.reply(COMMAND_ROLE_DENIED_TEXT);
      return true;
    }
    return false;
  }
}
