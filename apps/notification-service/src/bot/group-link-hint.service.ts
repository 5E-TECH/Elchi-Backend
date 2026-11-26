import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramChat } from '../entities/telegram-chat.entity';
import { BotOutboxService } from './bot-outbox.service';
import type { TelegramChatMemberUpdated } from './telegram.types';

/**
 * Bir martalik havola (`startgroup`) bilan qo'shilganda Telegram avval
 * `my_chat_member`, darhol keyin `/start <kod>` yuboradi — ulanish shu vaqt
 * ichida yozilib ulguradi va ogohlantirish CHIQMAYDI.
 */
export const GROUP_LINK_HINT_DELAY_MS = 20_000;

export const GROUP_NOT_LINKED_TEXT =
  "⚠️ Bot guruhga qo'shildi, lekin guruh Elchi tizimiga hali ULANMAGAN — hisobot va xabarlar kelmaydi.\n\n" +
  'Elchi kabinetida bir martalik havolani oching va shu guruhni tanlang (10 daqiqa amal qiladi):\n' +
  '• Filial kassasi hisoboti — filial sahifasi → «Kassa hisoboti · Telegram» → «Ulash» (asosiy kassa — HQ filiali sahifasida);\n' +
  '• Market buyurtmalari — «Telegram guruhini ulash».';

const GROUP_TYPES = new Set(['group', 'supergroup']);
const OUTSIDE = new Set(['left', 'kicked']);
const INSIDE = new Set(['member', 'administrator']);

/**
 * (prod 2026-11-25) Ega botni guruhga oddiy yo'l bilan qo'shdi, guruh esa
 * ulanmadi — bot jim qoldi, smena hisoboti kelmadi va sababi ko'rinmadi.
 * Endi bot yangi guruhga qo'shilib, belgilangan vaqtda ulanmasa — guruhga
 * ulash yo'li BIR marta yoziladi.
 *
 * Best-effort: jarayon qayta ishga tushsa ogohlantirish yo'qoladi (pul yoki
 * holatga ta'siri yo'q). Holat yuborishdan oldin bazadan qayta o'qiladi —
 * ulanish boshqa replikada bajarilgan bo'lsa ham to'g'ri ishlaydi.
 */
@Injectable()
export class GroupLinkHintService implements OnModuleDestroy {
  private readonly logger = new Logger(GroupLinkHintService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectRepository(TelegramChat)
    private readonly chats: Repository<TelegramChat>,
    private readonly outbox: BotOutboxService,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** `my_chat_member`: bot guruhga QO'SHILDI — tekshiruv rejalashtiriladi. */
  onMembership(update: TelegramChatMemberUpdated): void {
    const chatId = String(update?.chat?.id ?? '');
    // Kanalga yozilmaydi (u yerda /start ham, guruh ulash ham yo'q).
    if (!chatId || !GROUP_TYPES.has(String(update.chat.type ?? ''))) return;
    const next = String(update.new_chat_member?.status ?? '');
    if (OUTSIDE.has(next)) {
      this.cancel(chatId);
      return;
    }
    // Admin huquqi berilishi (member → administrator) — qo'shilish emas.
    const previous = String(update.old_chat_member?.status ?? '');
    if (!INSIDE.has(next) || !OUTSIDE.has(previous)) return;
    this.cancel(chatId);
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      void this.remind(chatId).catch((error: unknown) =>
        this.logger.warn(
          `guruh ${chatId}: ulash eslatmasi — ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, GROUP_LINK_HINT_DELAY_MS);
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  /** Guruh hamon hech narsaga ulanmagan bo'lsa — ulash yo'li yoziladi. */
  async remind(chatId: string): Promise<boolean> {
    // `telegram_chats` — market guruhlari ham (trigger, migratsiya 126) va
    // filial kassasi guruhlari ham.
    const linked = await this.chats.findOne({
      select: { id: true },
      where: { chat_id: chatId, is_active: true },
    });
    if (linked) return false;
    await this.outbox.send({
      chatId,
      text: GROUP_NOT_LINKED_TEXT,
      source: 'bot.group_not_linked',
    });
    return true;
  }

  private cancel(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }
}
