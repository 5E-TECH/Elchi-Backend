import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActivityLogService,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
} from '@app/common';
import { TelegramMarket } from '../entities/telegram-market.entity';
import { NotificationInboxService } from '../notification-inbox.service';
import { BotSessionService } from './bot-session.service';

export type ChannelInactiveReason =
  'kicked' | 'left' | 'blocked_on_send' | 'chat_not_found';

/**
 * (9HIaV80X #1) Kanal holati: bot guruhdan chiqarilsa / foydalanuvchi botni
 * bloklasa tizim abadiy urinavermaydi.
 *  - guruh → `telegram_markets.is_active = false` + activity log + admin
 *    inbox'iga `telegram.channel_inactive`;
 *  - shaxsiy chat → sessiyada `blocked_at` (qayta `member` bo'lsa tozalanadi).
 * Guruh qayta faollashtirilishi faqat admin orqali (PATCH /notifications/:id).
 */
@Injectable()
export class BotChannelService {
  private readonly logger = new Logger(BotChannelService.name);

  constructor(
    @InjectRepository(TelegramMarket)
    private readonly markets: Repository<TelegramMarket>,
    private readonly sessions: BotSessionService,
    private readonly activityLog: ActivityLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  static isGroupChat(chatId: string): boolean {
    return String(chatId).startsWith('-');
  }

  async markInactive(
    chatId: string,
    botSlug: string,
    reason: ChannelInactiveReason,
  ): Promise<{ deactivated: number }> {
    if (!BotChannelService.isGroupChat(chatId)) {
      await this.sessions.update(chatId, botSlug, (session) => ({
        state: { ...session.state, blocked_at: new Date().toISOString() },
      }));
      await this.activityLog.log({
        entity_type: 'TelegramChat',
        entity_id: chatId,
        action: 'notification.tg_channel_inactive',
        metadata: { reason, chat_type: 'private' },
      });
      return { deactivated: 0 };
    }

    // (G085w5Qr) Sabab va vaqt qatorning o'zida ham saqlanadi — jadval
    // («Bot guruhdan chiqarilgan…») va market holati endpointi shuni o'qiydi.
    const rows: Array<{ id: string; market_id: string }> =
      await this.markets.query(
        `UPDATE "notification_schema"."telegram_markets"
            SET "is_active" = false, "inactive_reason" = $2,
                "inactive_at" = now(), "updatedAt" = now()
          WHERE "group_id" = $1 AND "is_deleted" = false AND "is_active" = true
        RETURNING "id", "market_id"`,
        [chatId, reason],
      );
    const changed = Array.isArray(rows[0]) ? (rows[0] as typeof rows) : rows;
    for (const row of changed) {
      await this.activityLog.log({
        entity_type: 'TelegramMarket',
        entity_id: String(row.id),
        action: 'notification.tg_channel_inactive',
        metadata: {
          reason,
          group_id: chatId,
          market_id: String(row.market_id),
        },
      });
    }
    if (changed.length) {
      this.logger.warn(
        `Telegram guruh ${chatId}: bot ${reason} — ${changed.length} ta ulanish nofaol qilindi`,
      );
      await this.alertAdmins(chatId, reason, changed);
    }
    return { deactivated: changed.length };
  }

  /**
   * (BOT-3 #6) Guruh supergroup'ga aylandi (`migrate_to_chat_id` — Telegram
   * javobida yoki kiruvchi servis xabarida): ulanish (`telegram_markets.
   * group_id`, trigger `telegram_chats` ni ham), navbatdagi xabarlar va
   * kartalar YANGI chat id'ga ko'chadi. Avval xabar `dead` bo'lardi, guruh
   * esa «faol» ko'rinib, hech narsa yetib bormasdi. Idempotent.
   */
  async migrateChat(
    oldChatId: string,
    newChatId: string,
  ): Promise<{ markets: number; outbox: number }> {
    if (!oldChatId || !newChatId || oldChatId === newChatId) {
      return { markets: 0, outbox: 0 };
    }
    const changed = <T>(result: unknown): T[] =>
      Array.isArray(result) && Array.isArray(result[0])
        ? (result[0] as T[])
        : Array.isArray(result)
          ? (result as T[])
          : [];
    const markets = changed<{ id: string; market_id: string }>(
      await this.markets.query(
        `UPDATE "notification_schema"."telegram_markets"
            SET "group_id" = $2, "updatedAt" = now()
          WHERE "group_id" = $1 AND "is_deleted" = false
        RETURNING "id", "market_id"`,
        [oldChatId, newChatId],
      ),
    );
    // Navbatdagi (`pending`) xabarlar yangi id'ga va darhol muddati keladi.
    // `sending` — boshqa urinish ICHIDA (masalan throttle kutishida): faqat
    // `chat_id` yangilanadi, holatiga TEGILMAYDI — u o'z urinishini o'zi
    // yakunlaydi (aks holda ikkinchi ishchi ham olib, xabar ikki marta ketardi).
    const outbox = changed<{ id: string }>(
      await this.markets.query(
        `UPDATE "notification_schema"."telegram_outbox"
            SET "chat_id" = $2,
                "next_attempt_at" = CASE WHEN "status" = 'pending' THEN now() ELSE "next_attempt_at" END,
                "updated_at" = CASE WHEN "status" = 'pending' THEN now() ELSE "updated_at" END
          WHERE "chat_id" = $1 AND "status" IN ('pending', 'sending')
        RETURNING "id"`,
        [oldChatId, newChatId],
      ),
    );
    // Eski (oddiy guruh) kartalari supergroup'da tahrirlanmaydi (message_id
    // yaroqsiz) — o'chiriladi: keyingi holatda kerak bo'lsa yangi karta.
    await this.markets.query(
      `DELETE FROM "notification_schema"."telegram_order_cards"
        WHERE "chat_id" = $1`,
      [oldChatId],
    );
    for (const row of markets) {
      await this.activityLog.log({
        entity_type: 'TelegramMarket',
        entity_id: String(row.id),
        action: 'notification.tg_group_migrated',
        metadata: {
          from_group_id: oldChatId,
          to_group_id: newChatId,
          market_id: String(row.market_id),
        },
      });
    }
    if (markets.length || outbox.length) {
      this.logger.warn(
        `Telegram guruh ${oldChatId} supergroup'ga aylandi → ${newChatId}: ${markets.length} ulanish, ${outbox.length} navbatdagi xabar ko'chirildi`,
      );
    }
    return { markets: markets.length, outbox: outbox.length };
  }

  /**
   * Bot qayta `member` / `administrator`:
   *  - shaxsiy chat — blok olib tashlanadi;
   *  - guruh — faqat huquq olingani uchun (`blocked_on_send`, «not enough
   *    rights») nofaol bo'lgan ulanish qayta FAOL (huquq qaytdi). Chiqarilgan
   *    (`kicked` / `left`) ulanish avvalgidek admin / qayta ulash orqali.
   */
  async markActive(chatId: string, botSlug: string): Promise<void> {
    if (BotChannelService.isGroupChat(chatId)) {
      await this.reactivateGroup(chatId);
      return;
    }
    const session = await this.sessions.load(chatId, botSlug);
    if (!session.state.blocked_at) return;
    await this.sessions.update(chatId, botSlug, (current) => {
      const state = { ...current.state };
      delete state.blocked_at;
      return { state };
    });
    await this.activityLog.log({
      entity_type: 'TelegramChat',
      entity_id: chatId,
      action: 'notification.tg_channel_active',
      metadata: { chat_type: 'private' },
    });
  }

  private async reactivateGroup(chatId: string): Promise<void> {
    const rows = await this.markets.query(
      `UPDATE "notification_schema"."telegram_markets"
          SET "is_active" = true, "inactive_reason" = NULL,
              "inactive_at" = NULL, "updatedAt" = now()
        WHERE "group_id" = $1 AND "is_deleted" = false AND "is_active" = false
          AND "inactive_reason" = 'blocked_on_send'
      RETURNING "id", "market_id"`,
      [chatId],
    );
    const changed = (
      Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows
    ) as Array<{ id: string; market_id: string }>;
    for (const row of Array.isArray(changed) ? changed : []) {
      await this.activityLog.log({
        entity_type: 'TelegramMarket',
        entity_id: String(row.id),
        action: 'notification.tg_channel_active',
        metadata: { group_id: chatId, market_id: String(row.market_id) },
      });
    }
    if (Array.isArray(changed) && changed.length) {
      this.logger.log(
        `Telegram guruh ${chatId}: bot huquqi qaytdi — ${changed.length} ta ulanish qayta faol`,
      );
    }
  }

  private async alertAdmins(
    chatId: string,
    reason: ChannelInactiveReason,
    rows: Array<{ id: string; market_id: string }>,
  ): Promise<void> {
    try {
      // NotificationInboxService → NotificationServiceService → outbox →
      // shu servis: DI halqasi bo'lmasligi uchun chaqiruv paytida olinadi.
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      const markets = [...new Set(rows.map((row) => String(row.market_id)))];
      await inbox.dispatch({
        type: 'telegram.channel_inactive',
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        title: 'Telegram guruhi nofaol',
        body: `Bot guruhdan chiqarildi yoki bloklandi (${reason}). Marketlar: ${markets.join(', ')}. Guruhni qayta ulang (Bildirishnomalar → Telegram guruhlari).`,
        roles: ['admin', 'superadmin'],
        channels: [NotificationChannel.IN_APP, NotificationChannel.REALTIME],
        group_key: `telegram:channel_inactive:${chatId}`,
        data: { chat_id: chatId, market_ids: markets, reason },
      } as never);
    } catch (error) {
      this.logger.error(
        `telegram.channel_inactive admin xabari yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.alertMarkets(chatId, reason, rows);
  }

  /**
   * (BOT-3 #6) Market EGASIGA ham (in-app + shaxsiy Telegram): guruhga
   * kartalar endi bormaydi. Huquq olingan bo'lsa — qaytarilgach o'zi qayta
   * yoqiladi; chiqarilgan bo'lsa — botni qo'shib, kabinetdan qayta ulash.
   */
  private async alertMarkets(
    chatId: string,
    reason: ChannelInactiveReason,
    rows: Array<{ id: string; market_id: string }>,
  ): Promise<void> {
    try {
      const inbox = this.moduleRef.get(NotificationInboxService, {
        strict: false,
      });
      const markets = [...new Set(rows.map((row) => String(row.market_id)))];
      await inbox.dispatch({
        type: 'telegram.market_channel_inactive',
        category: NotificationCategory.SYSTEM,
        priority: NotificationPriority.HIGH,
        title: 'Telegram guruhingiz nofaol',
        body:
          reason === 'blocked_on_send'
            ? "Bot guruhga xabar yubora olmayapti (huquqi olingan). Botga xabar yuborish huquqini qaytaring — guruh o'zi qayta yoqiladi."
            : "Bot guruhdan chiqarilgan — buyurtma kartalari guruhga bormaydi. Botni guruhga qo'shing va kabinetdan guruhni qayta ulang.",
        recipient_ids: markets,
        channels: [
          NotificationChannel.IN_APP,
          NotificationChannel.REALTIME,
          NotificationChannel.TELEGRAM,
        ],
        group_key: `telegram:market_channel_inactive:${chatId}`,
        data: { chat_id: chatId, reason },
      });
    } catch (error) {
      this.logger.error(
        `telegram.market_channel_inactive xabari yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
