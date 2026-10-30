import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
/** Shundan eski, outbox'da navbati yo'q band qilish — yetim, qayta olinadi. */
const CARD_CLAIM_STALE_MS = 5 * 60_000;

const rowsOf = (result: unknown): unknown[] => {
  if (!Array.isArray(result)) return [];
  // pg INSERT/UPDATE … RETURNING: TypeORM `query` → rows yoki [rows, count].
  if (Array.isArray(result[0])) return result[0] as unknown[];
  return result;
};

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
export class OrderCardSyncService implements OnModuleInit {
  private readonly logger = new Logger(OrderCardSyncService.name);
  /** (BOT-3 #4) Buyurtma bo'yicha navbat (jarayon ichidagi keyed mutex). */
  private readonly orderTails = new Map<string, Promise<void>>();

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

  onModuleInit() {
    // (BOT-3 #4) Navbatda turgan karta yuborilgach, shu orada kelgan holat
    // o'zgarishi bo'lsa — karta oxirgi holatga qayta sinxronlanadi.
    this.outbox.onCardSent((orderId) => this.resync(orderId));
  }

  async sync(event: OrderStatusEvent): Promise<CardSyncResult> {
    const orderId = text(event?.order_id);
    const toStatus = text(event?.to_status);
    if (!/^\d{1,20}$/.test(orderId) || !toStatus) {
      return { sent: 0, edited: 0, revoked: 0 };
    }
    const fromStatus = text(event?.from_status);
    const creation =
      CREATION_STATUSES.has(toStatus) &&
      (!fromStatus || fromStatus === 'created');
    return this.serial(orderId, () =>
      this.run(orderId, creation, text(event?.market_id)),
    );
  }

  /** (BOT-3 #4) Kartalarni joriy holatga keltirish (yangi karta yuborilmaydi). */
  async resync(orderId: string): Promise<CardSyncResult> {
    return this.serial(orderId, () => this.run(orderId, false, ''));
  }

  /**
   * (BOT-3 #4) Bir buyurtma kartalari KETMA-KET: qulf endi faqat qisqa
   * tranzaksiyada, tarmoq (RPC + Telegram) undan tashqarida — parallel
   * hodisalar (RMQ prefetch) eski holat bilan yangisini bosib ketmasin.
   * Har ish o'z navbatida ma'lumotni QAYTA o'qiydi, ya'ni oxirgisi oxirgi
   * holatni yozadi. (Bitta notification-service jarayoni ichida.)
   */
  private serial<T>(orderId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.orderTails.get(orderId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.orderTails.set(orderId, tail);
    void tail.then(() => {
      if (this.orderTails.get(orderId) === tail) {
        this.orderTails.delete(orderId);
      }
    });
    return next;
  }

  private async run(
    orderId: string,
    creation: boolean,
    marketId: string,
  ): Promise<CardSyncResult> {
    const result: CardSyncResult = { sent: 0, edited: 0, revoked: 0 };

    /**
     * (BOT-3 #4) Tranzaksiya FAQAT qisqa: buyurtma bo'yicha qulf, kartalarni
     * o'qish va yangi guruh kartasi uchun JOY BAND QILISH (`message_id`
     * NULL qator — har guruhga bitta karta kafolati). Telegram'ga chiqish
     * va order-service RPC tranzaksiyadan TASHQARIDA — ulanish va qulf
     * tarmoqni kutib turmaydi. Eskirgan band qilish (jarayon claim va
     * outbox orasida o'lgan — 5 daqiqadan eski, outbox'da navbati yo'q)
     * qayta olinadi.
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
        const sentTo = new Set(
          rows.filter((row) => row.message_id).map((row) => row.chat_id),
        );
        for (const group of groups) {
          if (sentTo.has(group.chat_id)) continue;
          sentTo.add(group.chat_id);
          const inserted: unknown = await manager.query(
            `INSERT INTO "notification_schema"."telegram_order_cards" AS c
                    ("order_id", "chat_id", "message_id", "kind", "updated_at")
             VALUES ($1, $2, NULL, 'group', now())
             ON CONFLICT ("order_id", "chat_id") DO UPDATE
                SET "updated_at" = now(), "resync_pending" = false
              WHERE c."message_id" IS NULL
                AND c."updated_at" < now() - ($3::int * interval '1 millisecond')
                AND NOT EXISTS (
                      SELECT 1 FROM "notification_schema"."telegram_outbox" o
                       WHERE o."card_order_id" = $1 AND o."chat_id" = $2
                         AND o."status" IN ('pending', 'sending'))
             RETURNING "chat_id"`,
            [orderId, group.chat_id, CARD_CLAIM_STALE_MS],
          );
          if (rowsOf(inserted).length) claimed.push(group);
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

    /**
     * (BOT-2 #5) Guruh kartasi faqat guruh hamon FAOL va buyurtmaning
     * O'Z marketining `create` guruhi bo'lsa tahrirlanadi: uzilgan /
     * nofaol qilingan yoki boshqa marketga o'tgan guruhdagi eski karta
     * yangilanmaydi. Hodisada `market_id` faqat yaratilishda keladi —
     * qolgan holatlarda u order-service kartasidan olinadi; aniqlanmasa
     * hech bir guruh kartasi tahrirlanmaydi (fail-closed). Tranzaksiyadan
     * TASHQARIDA (RPC qulf ichida kutilmaydi).
     */
    const claimedChats = new Set(claimed.map((group) => group.chat_id));
    const groupRows = cards.filter(
      (row) => row.kind === 'group' && !claimedChats.has(row.chat_id),
    );
    const groupChatIds = [...new Set(groupRows.map((row) => row.chat_id))];
    const ownerMarketId = groupChatIds.length
      ? /^\d{1,20}$/.test(marketId)
        ? marketId
        : text((await card())?.market_id)
      : '';
    const activeGroups =
      groupChatIds.length && /^\d{1,20}$/.test(ownerMarketId)
        ? new Set(
            (
              await this.dataSource.getRepository(TelegramChat).find({
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
          if (claimedChats.has(row.chat_id)) continue;
          if (!row.message_id) {
            // Hali yuborilmagan (outbox navbatida): hodisa TASHLANMAYDI —
            // outbox yuborgach karta oxirgi holatga qayta sinxronlanadi.
            // Ega / faol guruh tekshiruvidan OLDIN: RPC yiqilsa ham belgi
            // qoladi; qayta sinxron o'sha qo'riqchilarni qayta qo'llaydi.
            await this.markResync(orderId, row.chat_id);
            continue;
          }
          if (!activeGroups.has(row.chat_id)) continue;
          const current = await card();
          if (!current) continue;
          const edited = await this.transport.editMessage(
            row.chat_id,
            row.message_id,
            {
              text: groupCardText(current),
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: groupCardKeyboard(this.cabinetUrl, orderId),
              },
            },
          );
          // Tahrir o'tmadi (editMessage throw qilmaydi) — holat yozilmaydi,
          // `resync_pending` qoladi (keyingi hodisa / yuborish qayta uradi).
          if (!edited) continue;
          await this.dataSource.getRepository(TelegramOrderCard).update(
            { order_id: orderId, chat_id: row.chat_id },
            {
              status: current.status,
              resync_pending: false,
              updated_at: new Date(),
            },
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

  /** Navbatdagi karta: yuborilgach qayta sinxronlansin (`resync_pending`). */
  private async markResync(orderId: string, chatId: string): Promise<void> {
    const marked: unknown = await this.dataSource.query(
      `UPDATE "notification_schema"."telegram_order_cards"
          SET "resync_pending" = true
        WHERE "order_id" = $1 AND "chat_id" = $2 AND "message_id" IS NULL
      RETURNING "chat_id"`,
      [orderId, chatId],
    );
    // Shu orada outbox yubordi (message_id yozildi) — darhol qayta sinxron.
    if (!rowsOf(marked).length) {
      void this.resync(orderId).catch((error: unknown) =>
        this.logger.warn(
          `karta #${orderId} qayta sinxronlanmadi: ${this.transport.describe(error)}`,
        ),
      );
    }
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
      // (BOT-3 #6) Guruh supergroup'ga aylangan bo'lsa — yangi id ostida.
      const chatId = sent.chat_id ?? group.chat_id;
      // Band qilish qatori migrateChat'da yangi id'ga ko'chgan bo'ladi.
      if (sent.status === 'sent' && messageId) {
        await this.dataSource.getRepository(TelegramOrderCard).update(
          { order_id: data.id, chat_id: chatId },
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
            { order_id: data.id, chat_id: chatId },
            { status: data.status, updated_at: new Date() },
          );
      } else {
        await this.releaseClaim(data.id, chatId);
      }
      await this.audit(data.id, chatId, data, 'sent', sent.status);
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
      .catch((error: unknown) =>
        this.logger.warn(
          `karta #${orderId} band qilishi bo'shatilmadi (5 daqiqadan keyin qayta olinadi / tozalanadi): ${this.transport.describe(error)}`,
        ),
      );
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
