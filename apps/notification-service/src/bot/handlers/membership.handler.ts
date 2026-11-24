import { Injectable, Logger, Optional } from '@nestjs/common';
import { BotChannelService } from '../bot-channel.service';
import { GroupLinkHintService } from '../group-link-hint.service';
import type { TelegramChatMemberUpdated } from '../telegram.types';

/**
 * (9HIaV80X #1 / uCrzrElu #6) `my_chat_member` — bot holati o'zgardi:
 *  - `kicked` / `left` → kanal nofaol (guruh: `telegram_markets.is_active =
 *    false` + admin inbox; shaxsiy chat: bloklangan deb belgilanadi);
 *  - `member` / `administrator` → shaxsiy chat blokdan chiqariladi; guruhga
 *    yangi qo'shilgan bo'lsa va ulanmasa — ulash yo'li (`GroupLinkHintService`).
 * Ilgari `allowed_updates` da bu tur yo'q edi — tizim bot bloklanganini
 * hech qachon bilmasdi va abadiy urinaverardi.
 */
@Injectable()
export class MembershipHandler {
  private readonly logger = new Logger(MembershipHandler.name);

  constructor(
    private readonly channels: BotChannelService,
    @Optional() private readonly linkHint?: GroupLinkHintService,
  ) {}

  async handle(slug: string, update: TelegramChatMemberUpdated): Promise<void> {
    const chatId = update?.chat?.id;
    if (chatId === undefined || chatId === null) return;
    const status = String(update.new_chat_member?.status ?? '');
    this.linkHint?.onMembership(update);
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

  /** (BOT-3 #6) Kiruvchi `migrate_to_chat_id` (eski guruhdagi servis xabari). */
  async migrate(oldChatId: string, newChatId: string): Promise<void> {
    if (!/^-\d{1,20}$/.test(newChatId)) return;
    await this.channels.migrateChat(oldChatId, newChatId);
  }
}
