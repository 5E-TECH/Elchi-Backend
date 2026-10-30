import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, EntityManager, In } from 'typeorm';
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

    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        CARD_LOCK_NS,
        orderId,
      ]);
      const cards = await manager
        .getRepository(TelegramOrderCard)
        .find({ where: { order_id: orderId } });
      let data: GroupCardData | null | undefined;
      const card = async () => {
        if (data === undefined) data = await this.fetchCard(orderId);
        return data;
      };

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
        const known = new Set(cards.map((row) => row.chat_id));
        for (const group of groups) {
          if (known.has(group.chat_id)) continue;
          known.add(group.chat_id);
          const current = await card();
          if (!current) break;
          if (await this.sendGroupCard(manager, group, current))
            result.sent += 1;
        }
      }

      /**
       * (BOT-2 #5) Guruh kartasi faqat guruh hamon FAOL va buyurtmaning
       * O'Z marketining `create` guruhi bo'lsa tahrirlanadi: uzilgan /
       * nofaol qilingan yoki boshqa marketga o'tgan guruhdagi eski karta
       * yangilanmaydi. Hodisada `market_id` faqat yaratilishda keladi —
       * qolgan holatlarda u order-service kartasidan olinadi; aniqlanmasa
       * hech bir guruh kartasi tahrirlanmaydi (fail-closed).
       */
      const groupChatIds = [
        ...new Set(
          cards.filter((row) => row.kind === 'group').map((row) => row.chat_id),
        ),
      ];
      const ownerMarketId = groupChatIds.length
        ? /^\d{1,20}$/.test(marketId)
          ? marketId
          : text((await card())?.market_id)
        : '';
      const activeGroups =
        groupChatIds.length && /^\d{1,20}$/.test(ownerMarketId)
          ? new Set(
              (
                await manager.getRepository(TelegramChat).find({
                  select: { chat_id: true },
                  where: {
                    chat_id: In(groupChatIds),
                    owner_type: 'market',
                    owner_id: ownerMarketId,
                    scope: 'create',
                    is_active: true,
                  },
                })
              ).map((chat) => chat.chat_id),
            )
          : new Set<string>();

      for (const row of cards) {
        try {
          if (row.kind === 'group') {
            if (!activeGroups.has(row.chat_id)) continue;
            const current = await card();
            if (!current) continue;
            await this.transport.editMessage(row.chat_id, row.message_id, {
              text: groupCardText(current),
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: groupCardKeyboard(this.cabinetUrl, orderId),
              },
            });
            await manager
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
    });
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

  private async sendGroupCard(
    manager: EntityManager,
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
      });
      const messageId = sent.result?.message_id;
      if (sent.status === 'sent' && messageId) {
        await manager.getRepository(TelegramOrderCard).upsert(
          {
            order_id: data.id,
            chat_id: group.chat_id,
            message_id: String(messageId),
            kind: 'group',
            actor_user_id: null,
            status: data.status,
            updated_at: new Date(),
          },
          ['order_id', 'chat_id'],
        );
      }
      await this.audit(data.id, group.chat_id, data, 'sent', sent.status);
      return sent.status === 'sent' || sent.status === 'queued';
    } catch (error) {
      // Guruhga yuborib bo'lmadi (bot chiqarilgan va h.k.) — buyurtma oqimiga
      // ta'sir yo'q; kanal holatini outbox/membership o'zi belgilaydi.
      this.logger.warn(
        `guruh kartasi #${data.id} (chat ${group.chat_id}) yuborilmadi: ${this.transport.describe(error)}`,
      );
      return false;
    }
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
