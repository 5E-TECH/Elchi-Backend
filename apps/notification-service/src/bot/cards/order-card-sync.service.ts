import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, In } from 'typeorm';
import { ActivityLogService, rmqSend } from '@app/common';
import { TelegramChat } from '../../entities/telegram-chat.entity';
import { TelegramOrderCard } from '../../entities/telegram-order-card.entity';
import { BotOutboxService } from '../bot-outbox.service';
import { BotTransportService } from '../bot-transport.service';
import { CourierService } from '../courier/courier.service';
import { GroupCardData, groupCardKeyboard, groupCardText } from './group-card';

/** order-service outbox hodisasi (OrderNotificationService.onStatusChange). */
export const TELEGRAM_ORDER_STATUS_PATTERN =
  'notification.telegram.order_status';

export interface OrderStatusEvent {
  order_id?: unknown;
  from_status?: unknown;
  to_status?: unknown;
  market_id?: unknown;
}

export interface CardSyncResult {
  sent: number;
  edited: number;
  revoked: number;
}

/** pg_advisory_xact_lock nomlar fazosi (buyurtma kartasi sinxroni). */
const CARD_LOCK_NS = 7421;
const CREATION_STATUSES = new Set(['created', 'new']);

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/**
 * (h9newLsd #5 / ysBqD9Nx #3-#4) Buyurtma holati o'zgarganda Telegram
 * KARTALARI — yangi xabar emas, mavjud karta TAHRIRLANADI.
 *
 *  - Yaratilish (null/created → created/new): market `create` guruhlariga
 *    (telegram_chats, faol) karta — har guruhga BITTA (buyurtma bo'yicha
 *    advisory lock: created→new ketma-ket hodisalari ikki karta bermaydi).
 *  - Keyingi holatlar: `telegram_order_cards` dagi har karta — guruh kartasi
 *    yangi ma'lumot bilan, kuryer kartasi kuryerning O'Z JWT'si bilan
 *    (`CourierService.refreshCardForChat`).
 *  - Guruhga yuborib bo'lmasa — faqat WARN: buyurtma oqimiga ta'sir YO'Q
 *    (hodisa outbox orqali, buyurtma allaqachon commit bo'lgan).
 *  - Har guruh xabari audit izida (`notification.tg_group_card`).
 */
@Injectable()
export class OrderCardSyncService {
  private readonly logger = new Logger(OrderCardSyncService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject('ORDER') private readonly orders: ClientProxy,
    private readonly outbox: BotOutboxService,
    private readonly transport: BotTransportService,
    private readonly courier: CourierService,
    private readonly activityLog: ActivityLogService,
    private readonly config: ConfigService,
  ) {}

  private get cabinetUrl(): string {
    return (
      this.config.get<string>('ELCHI_CABINET_URL') ??
      'https://admin.elchipochta.uz'
    );
  }

  async sync(event: OrderStatusEvent): Promise<CardSyncResult> {
    const result: CardSyncResult = { sent: 0, edited: 0, revoked: 0 };
    const orderId = text(event?.order_id);
    const toStatus = text(event?.to_status);
    if (!/^\d{1,20}$/.test(orderId) || !toStatus) return result;
    const fromStatus = text(event?.from_status);
    const marketId = text(event?.market_id);
    const creation =
      CREATION_STATUSES.has(toStatus) &&
      (!fromStatus || fromStatus === 'created');

    /**
     * (BOT-3 #4) Tranzaksiya FAQAT qisqa: buyurtma bo'yicha qulf, kartalarni
     * o'qish va yangi guruh kartasi uchun JOY BAND QILISH (`message_id`
     * NULL qator — har guruhga bitta karta kafolati). Telegram'ga chiqish
     * va order-service RPC tranzaksiyadan TASHQARIDA — ulanish va qulf
     * tarmoqni kutib turmaydi.
     */
    const claimed: TelegramChat[] = [];
    const cards = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        CARD_LOCK_NS,
        orderId,
      ]);
      const rows = await manager
        .getRepository(TelegramOrderCard)
        .find({ where: { order_id: orderId } });
      if (creation && /^\d{1,20}$/.test(marketId)) {
        const groups = await manager.getRepository(TelegramChat).find({
          where: {
            owner_type: 'market',
            owner_id: marketId,
            scope: 'create',
            is_active: true,
            chat_type: In(['group', 'channel']),
          },
        });
        const known = new Set(rows.map((row) => row.chat_id));
        for (const group of groups) {
          if (known.has(group.chat_id)) continue;
          known.add(group.chat_id);
          const inserted: unknown = await manager.query(
            `INSERT INTO "notification_schema"."telegram_order_cards"
                    ("order_id", "chat_id", "message_id", "kind", "updated_at")
             VALUES ($1, $2, NULL, 'group', now())
             ON CONFLICT ("order_id", "chat_id") DO NOTHING
             RETURNING "chat_id"`,
            [orderId, group.chat_id],
          );
          if (Array.isArray(inserted) && inserted.length) claimed.push(group);
        }
      }
      return rows;
    });

    let data: GroupCardData | null | undefined;
    const card = async () => {
      if (data === undefined) data = await this.fetchCard(orderId);
      return data;
    };

    for (const group of claimed) {
      const current = await card();
      if (!current) {
        await this.releaseClaim(orderId, group.chat_id);
        continue;
      }
      if (await this.sendGroupCard(group, current)) result.sent += 1;
    }

    for (const row of cards) {
      try {
        if (row.kind === 'group') {
          // Hali yuborilmagan (outbox navbatida) — yuborilgach outbox
          // message_id ni yozadi, keyingi hodisa tahrirlaydi.
          if (!row.message_id) continue;
          const current = await card();
          if (!current) continue;
          await this.transport.editMessage(row.chat_id, row.message_id, {
            text: groupCardText(current),
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: groupCardKeyboard(this.cabinetUrl, orderId),
            },
          });
          await this.dataSource
            .getRepository(TelegramOrderCard)
            .update(
              { order_id: orderId, chat_id: row.chat_id },
              { status: current.status, updated_at: new Date() },
            );
          await this.audit(orderId, row.chat_id, current, 'edited');
          result.edited += 1;
        } else if (row.kind === 'courier') {
          const outcome = await this.courier.refreshCardForChat(
            row.chat_id,
            orderId,
            row.actor_user_id ? String(row.actor_user_id) : null,
          );
          if (outcome === 'edited') result.edited += 1;
          if (outcome === 'revoked') result.revoked += 1;
        }
      } catch (error) {
        this.logger.warn(
          `karta #${orderId} (${row.kind}, chat ${row.chat_id}) yangilanmadi: ${this.transport.describe(error)}`,
        );
      }
    }
    return result;
  }

  /** order-service `order.telegram_card` (PII bayrog'i u yerda qo'llangan). */
  private async fetchCard(orderId: string): Promise<GroupCardData | null> {
    try {
      const res = await rmqSend<{ data?: GroupCardData | null }>(
        this.orders,
        { cmd: 'order.telegram_card' },
        { order_id: orderId },
        { timeoutMs: 8000, retries: 1 },
      );
      const data = res?.data;
      return data && text(data.id) && text(data.status) ? data : null;
    } catch (error) {
      this.logger.warn(
        `order.telegram_card #${orderId}: ${this.transport.describe(error)}`,
      );
      return null;
    }
  }

  /**
   * Guruhga karta (band qilingan joyga). Darhol yuborilsa — `message_id`
   * shu yerda yoziladi; navbatga tushsa (429/5xx) — outbox yuborganda O'ZI
   * yozadi (`card_order_id`); yuborib bo'lmasa — band qilish bo'shatiladi.
   */
  private async sendGroupCard(
    group: TelegramChat,
    data: GroupCardData,
  ): Promise<boolean> {
    try {
      const sent = await this.outbox.send({
        chatId: group.chat_id,
        text: groupCardText(data),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: groupCardKeyboard(this.cabinetUrl, data.id),
        },
        source: 'bot.group_card',
        cardOrderId: data.id,
      });
      const messageId = sent.result?.message_id;
      if (sent.status === 'sent' && messageId) {
        await this.dataSource.getRepository(TelegramOrderCard).update(
          { order_id: data.id, chat_id: group.chat_id },
          {
            message_id: String(messageId),
            status: data.status,
            updated_at: new Date(),
          },
        );
      } else if (sent.status === 'queued') {
        await this.dataSource
          .getRepository(TelegramOrderCard)
          .update(
            { order_id: data.id, chat_id: group.chat_id },
            { status: data.status, updated_at: new Date() },
          );
      } else {
        await this.releaseClaim(data.id, group.chat_id);
      }
      await this.audit(data.id, group.chat_id, data, 'sent', sent.status);
      return sent.status === 'sent' || sent.status === 'queued';
    } catch (error) {
      // Guruhga yuborib bo'lmadi (bot chiqarilgan va h.k.) — buyurtma oqimiga
      // ta'sir yo'q; kanal holatini outbox/membership o'zi belgilaydi.
      this.logger.warn(
        `guruh kartasi #${data.id} (chat ${group.chat_id}) yuborilmadi: ${this.transport.describe(error)}`,
      );
      await this.releaseClaim(data.id, group.chat_id);
      return false;
    }
  }

  /** Yuborilmagan band qilish qatorini bo'shatadi (keyingi hodisa qayta urinadi). */
  private async releaseClaim(orderId: string, chatId: string): Promise<void> {
    await this.dataSource
      .query(
        `DELETE FROM "notification_schema"."telegram_order_cards"
          WHERE "order_id" = $1 AND "chat_id" = $2 AND "message_id" IS NULL`,
        [orderId, chatId],
      )
      .catch(() => undefined);
  }

  private async audit(
    orderId: string,
    chatId: string,
    data: GroupCardData,
    op: 'sent' | 'edited',
    delivery?: string,
  ): Promise<void> {
    await this.activityLog
      .log({
        entity_type: 'Order',
        entity_id: orderId,
        action: 'notification.tg_group_card',
        metadata: {
          op,
          chat_id: chatId,
          market_id: data.market_id ?? null,
          status: data.status,
          customer_pii: data.show_customer_pii !== false,
          ...(delivery ? { delivery } : {}),
        },
      })
      .catch(() => undefined);
  }
}
