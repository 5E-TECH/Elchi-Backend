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
 *  - shaxsiy chat → `telegram_blocked_chats` (BOT-3c: MUDDATSIZ; ilgari 24
 *    soatlik sessiyada edi) — qayta `member` yoki `/start` da o'chadi.
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
      await this.markets.query(
        `INSERT INTO "notification_schema"."telegram_blocked_chats"
                ("chat_id", "reason", "blocked_at")
         VALUES ($1, $2, now())
         ON CONFLICT ("chat_id") DO UPDATE
            SET "reason" = EXCLUDED."reason", "blocked_at" = EXCLUDED."blocked_at"`,
        [chatId, reason],
      );
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
   * Shaxsiy chat botni qayta ishga tushirdi (`member` yoki `/start`) — blok
   * olib tashlanadi (eski sessiya belgisi ham).
   */
  async markActive(chatId: string, botSlug: string): Promise<void> {
    if (BotChannelService.isGroupChat(chatId)) return;
    const deleted: unknown = await this.markets.query(
      `DELETE FROM "notification_schema"."telegram_blocked_chats"
        WHERE "chat_id" = $1
      RETURNING "chat_id"`,
      [chatId],
    );
    const rows = Array.isArray(deleted)
      ? Array.isArray(deleted[0])
        ? (deleted[0] as unknown[])
        : deleted
      : [];
    const session = await this.sessions.load(chatId, botSlug);
    if (session.state.blocked_at) {
      await this.sessions.update(chatId, botSlug, (current) => {
        const state = { ...current.state };
        delete state.blocked_at;
        return { state };
      });
    }
    if (!rows.length && !session.state.blocked_at) return;
    await this.activityLog.log({
      entity_type: 'TelegramChat',
      entity_id: chatId,
      action: 'notification.tg_channel_active',
      metadata: { chat_type: 'private' },
    });
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
  }
}
