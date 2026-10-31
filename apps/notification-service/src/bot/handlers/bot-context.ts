import type { BotActor } from '../bot-actor.service';
import type { OutboxSendResult } from '../bot-outbox.service';
import type { BotSession } from '../bot-session.service';
import type { TelegramBotAction } from '../../entities/telegram-bot-action.entity';
import type { InlineKeyboardMarkup, TelegramUpdate } from '../telegram.types';

/** Bitta update uchun handler konteksti (router quradi). */
export interface BotContext {
  slug: string;
  update: TelegramUpdate;
  chatId: string;
  chatType: string;
  isPrivate: boolean;
  /** Yuboruvchi odam (`message.from.id` / `callback_query.from.id`). */
  fromId: string | null;
  /** Kesilgan matn ('' — matn yo'q). */
  text: string;
  /** Aktor (bir marta yechiladi, fail-closed: null). */
  actor(): Promise<BotActor | null>;
  session(): Promise<BotSession>;
  /** Javob — outbox orqali (avval DB, keyin Telegram). */
  reply(
    text: string,
    extra?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboardMarkup },
  ): Promise<OutboxSendResult>;
}

/** Matnli update handleri: `true` — ishlandi (keyingisi chaqirilmaydi). */
export interface BotMessageHandler {
  handle(ctx: BotContext): Promise<boolean>;
}

/** `a:<action_id>` tugmasi handleri (amal turi bo'yicha). */
export interface BotActionHandler {
  readonly action: string;
  /** Muddati o'tgan tugma uchun maxsus matn (bo'lmasa umumiy). */
  readonly expiredText?: string;
  /** Tugma boshqa odamga tegishli bo'lsa (bo'lmasa umumiy). */
  readonly foreignText?: string;
  handle(ctx: BotContext, action: TelegramBotAction): Promise<void>;
}

export const BOT_ACTION_HANDLERS = Symbol('BOT_ACTION_HANDLERS');
