import { Injectable, Logger } from '@nestjs/common';
import { BotChannelService } from '../bot-channel.service';
import type { TelegramChatMemberUpdated } from '../telegram.types';

/**
 * (9HIaV80X #1 / uCrzrElu #6) `my_chat_member` — bot holati o'zgardi:
 *  - `kicked` / `left` → kanal nofaol (guruh: `telegram_markets.is_active =
 *    false` + admin inbox; shaxsiy chat: bloklangan deb belgilanadi);
 *  - `member` / `administrator` → shaxsiy chat blokdan chiqariladi.
 * Ilgari `allowed_updates` da bu tur yo'q edi — tizim bot bloklanganini
 * hech qachon bilmasdi va abadiy urinaverardi.
 */
@Injectable()
export class MembershipHandler {
  private readonly logger = new Logger(MembershipHandler.name);

  constructor(private readonly channels: BotChannelService) {}

  async handle(slug: string, update: TelegramChatMemberUpdated): Promise<void> {
    const chatId = update?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    const status = String(update.new_chat_member?.status ?? '');
    if (status === 'kicked' || status === 'left') {
      await this.channels.markInactive(String(chatId), slug, status);
      return;
    }
    if (status === 'member' || status === 'administrator') {
      await this.channels.markActive(String(chatId), slug);
      return;
    }
    this.logger.debug(`my_chat_member: e'tiborsiz holat ${status}`);
  }
}
