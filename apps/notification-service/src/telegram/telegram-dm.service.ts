import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  OutboxService,
  escapeTelegramHtml,
  maskPhonesForLog,
  rmqSend,
} from '@app/common';
import { Notification } from '../entities/notification.entity';
import { NotificationServiceService } from '../notification-service.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import {
  createTelegramLinkToken,
  verifyTelegramLinkToken,
} from './telegram-link';

/** Outbox hodisasi: shaxsiy Telegram xabarlari (rCFZAmOz #2). */
export const TELEGRAM_DM_DELIVER_PATTERN = 'notification.telegram.deliver';
const TELEGRAM_DM_OUTBOX_TARGET = 'NOTIFICATION';
/** Bitta outbox hodisasidagi qatorlar (Telegram ~30 xabar/s chegarasi). */
export const TELEGRAM_DM_CHUNK = 25;
/** Bir vaqtda yuboriladigan DM'lar. */
const DM_CONCURRENCY = 5;
const REASON_MAX = 200;

/** `delivery.telegram` uchun qabul qiluvchi rejasi. */
export type TelegramDmPlan = Map<string, Record<string, string>>;

const str = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

const short = (error: unknown) =>
  maskPhonesForLog(
    (
      str((error as { message?: unknown } | null)?.message) ||
      str(error) ||
      'unknown'
    ).replace(/\s+/g, ' '),
  ).slice(0, REASON_MAX);

/**
 * SHAXSIY Telegram xabari (rCFZAmOz). Guruh relay'idan (telegram_markets)
 * farqi: nishon — qabul qiluvchining `users.telegram_id` si.
 *
 * Oqim: dispatch → `plan` (identity'dan telegram_id, BULK) → qator
 * `delivery.telegram = queued | skipped(no_telegram_id) | no_provider` →
 * shu tranzaksiyada `enqueue` (outbox) → `deliver` yuboradi va natijani
 * `delivery.telegram = sent | failed (+telegram_error)` ga yozadi.
 *
 * Idempotent: `deliver` qatorni avval `queued → sending` bilan DA'VO qiladi
 * (shartli UPDATE) — outbox qayta yetkazsa ham bitta xabar ikki marta ketmaydi.
 */
@Injectable()
export class TelegramDmService {
  private readonly logger = new Logger(TelegramDmService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly outbox: OutboxService,
    private readonly contacts: SmsDispatchService,
    private readonly telegram: NotificationServiceService,
    private readonly config: ConfigService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private get botToken(): string {
    return (this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '').trim();
  }

  private get linkSecret(): string {
    return (
      this.config.get<string>('TELEGRAM_LINK_SECRET')?.trim() || this.botToken
    );
  }

  /**
   * Har qabul qiluvchi uchun `delivery.telegram`: chat ulangan — `queued`,
   * ulanmagan — `skipped` + `telegram_reason: no_telegram_id` (dispatch
   * YIQILMAYDI), bot tokeni yo'q — `no_provider`.
   */
  async plan(recipientIds: string[]): Promise<TelegramDmPlan> {
    const plan: TelegramDmPlan = new Map();
    if (!recipientIds.length) return plan;
    if (!this.botToken) {
      for (const id of recipientIds)
        plan.set(id, { telegram: NotificationDeliveryStatus.NO_PROVIDER });
      return plan;
    }
    let contacts: Map<string, { telegram_id?: string | null }>;
    try {
      contacts = await this.contacts.contacts(recipientIds);
    } catch (error) {
      this.logger.warn(`telegram DM: identity javob bermadi — ${short(error)}`);
      for (const id of recipientIds)
        plan.set(id, {
          telegram: NotificationDeliveryStatus.FAILED,
          telegram_error: 'contacts_unavailable',
        });
      return plan;
    }
    for (const id of recipientIds) {
      const chat = String(contacts.get(id)?.telegram_id ?? '').trim();
      plan.set(
        id,
        chat
          ? { telegram: NotificationDeliveryStatus.QUEUED }
          : {
              telegram: NotificationDeliveryStatus.SKIPPED,
              telegram_reason: 'no_telegram_id',
            },
      );
    }
    return plan;
  }

  /** Inbox qatorlari bilan BITTA tranzaksiyada navbatga (rollback → DM yo'q). */
  async enqueue(manager: EntityManager, notificationIds: string[]) {
    for (let i = 0; i < notificationIds.length; i += TELEGRAM_DM_CHUNK) {
      await this.outbox.enqueue(
        TELEGRAM_DM_OUTBOX_TARGET,
        TELEGRAM_DM_DELIVER_PATTERN,
        { notification_ids: notificationIds.slice(i, i + TELEGRAM_DM_CHUNK) },
        { manager },
      );
    }
  }

  /** Outbox iste'molchisi: da'vo qilingan qatorlarga shaxsiy xabar. */
  async deliver(input: { notification_ids?: unknown }) {
    const ids = (
      Array.isArray(input?.notification_ids) ? input.notification_ids : []
    )
      .map((id) => String(id ?? '').trim())
      .filter((id) => /^\d+$/.test(id));
    if (!ids.length) return { processed: 0, sent: 0, failed: 0 };

    // Da'vo: faqat `queued` qatorlar `sending` ga — qayta yetkazishda takror yo'q.
    const claimed: Array<{
      id: string;
      recipient_id: string;
      title: string;
      body: string | null;
    }> = await this.notifications.query(
      `UPDATE "notification_schema"."notifications"
          SET "delivery" = COALESCE("delivery", '{}'::jsonb) || '{"telegram":"sending"}'::jsonb
        WHERE "id" = ANY($1::bigint[])
          AND "delivery"->>'telegram' = 'queued'
      RETURNING "id", "recipient_id", "title", "body"`,
      [ids],
    );
    const rows = Array.isArray(claimed[0])
      ? (claimed[0] as typeof claimed)
      : claimed;
    if (!rows.length) return { processed: 0, sent: 0, failed: 0 };

    let contacts: Map<string, { telegram_id?: string | null }>;
    try {
      contacts = await this.contacts.contacts([
        ...new Set(rows.map((row) => String(row.recipient_id))),
      ]);
    } catch (error) {
      // Navbatga qaytariladi — outbox qayta uradi.
      await this.patch(
        rows.map((row) => String(row.id)),
        { telegram: NotificationDeliveryStatus.QUEUED },
      );
      throw error;
    }

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += DM_CONCURRENCY) {
      const results = await Promise.all(
        rows.slice(i, i + DM_CONCURRENCY).map(
          async (
            row,
          ): Promise<{
            id: string;
            patch: Record<string, string>;
          }> => {
            const chat = String(
              contacts.get(String(row.recipient_id))?.telegram_id ?? '',
            ).trim();
            if (!chat) {
              return {
                id: String(row.id),
                patch: {
                  telegram: NotificationDeliveryStatus.SKIPPED,
                  telegram_reason: 'no_telegram_id',
                },
              };
            }
            try {
              await this.telegram.sendDirectToGroup({
                group_id: chat,
                message: this.text(row),
                parse_mode: 'HTML',
              });
              return {
                id: String(row.id),
                patch: { telegram: NotificationDeliveryStatus.SENT },
              };
            } catch (error) {
              const reason = short(error);
              return {
                id: String(row.id),
                patch: {
                  telegram: NotificationDeliveryStatus.FAILED,
                  // 403 — foydalanuvchi botni bloklagan / chatni o'chirgan.
                  telegram_error:
                    /forbidden|blocked|deactivated|chat not found/i.test(reason)
                      ? `blocked_by_user: ${reason}`.slice(0, REASON_MAX)
                      : reason,
                },
              };
            }
          },
        ),
      );
      for (const result of results) {
        if (result.patch.telegram === NotificationDeliveryStatus.SENT)
          sent += 1;
        else if (result.patch.telegram === NotificationDeliveryStatus.FAILED)
          failed += 1;
        await this.patch([result.id], result.patch);
      }
    }
    return { processed: rows.length, sent, failed };
  }

  /** `title\n\nbody` — HTML-escape (relayTelegram bilan bir xil qoida). */
  private text(row: { title: string; body: string | null }) {
    const message = row.body
      ? `${escapeTelegramHtml(row.title)}\n\n${escapeTelegramHtml(row.body)}`
      : escapeTelegramHtml(row.title);
    return message.slice(0, 4096);
  }

  private async patch(ids: string[], patch: Record<string, string>) {
    if (!ids.length) return;
    await this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds(ids)
      .execute();
  }

  // ==================== ulash (rCFZAmOz #1) ====================

  /**
   * `POST /notifications/telegram/link` — tizimga kirgan foydalanuvchiga
   * o'z akkaunti uchun 15 daqiqalik havola.
   */
  linkToken(input: { user_id?: unknown }) {
    const userId = str(input?.user_id).trim();
    if (!/^\d{1,19}$/.test(userId))
      throw new RpcException({ statusCode: 401, message: 'Unauthorized' });
    if (!this.linkSecret)
      throw new RpcException({
        statusCode: 503,
        message: 'Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN)',
      });
    const { token, expires_at } = createTelegramLinkToken(
      userId,
      this.linkSecret,
    );
    const username = (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '')
      .trim()
      .replace(/^@/, '');
    return {
      statusCode: 200,
      message: 'Telegram link',
      data: {
        token,
        expires_at,
        deep_link: username ? `https://t.me/${username}?start=${token}` : null,
        // Havola bo'lmasa: botga shu buyruqni yuborish.
        command: `/start ${token}`,
      },
    };
  }

  /**
   * Bot `/start <token>` (FAQAT shaxsiy chat): token to'g'ri bo'lsa chat id
   * identity'ga `users.telegram_id` bo'lib yoziladi.
   */
  async bindFromStart(
    payload: string,
    chatId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const userId = verifyTelegramLinkToken(payload, this.linkSecret);
    if (!userId) {
      return {
        ok: false,
        message:
          "Havola noto'g'ri yoki muddati o'tgan. Elchi profilingizdan «Telegram'ni ulash» ni qayta bosing.",
      };
    }
    try {
      await rmqSend(
        this.identityClient,
        { cmd: 'identity.user.telegram_bind' },
        { user_id: userId, telegram_id: chatId },
      );
    } catch (error) {
      this.logger.warn(`telegram bind: ${short(error)}`);
      return {
        ok: false,
        message: "Ulab bo'lmadi, keyinroq qayta urinib ko'ring.",
      };
    }
    return {
      ok: true,
      message:
        'Telegram ulandi ✅ Endi Elchi bildirishnomalari shu chatga ham keladi. Uzish: /stop',
    };
  }

  /** Bot `/stop` — shu chat ulangan akkauntlardan uziladi. */
  async unbind(chatId: string): Promise<{ ok: boolean; message: string }> {
    try {
      await rmqSend(
        this.identityClient,
        { cmd: 'identity.user.telegram_unbind' },
        { telegram_id: chatId },
      );
      return { ok: true, message: 'Telegram uzildi.' };
    } catch (error) {
      this.logger.warn(`telegram unbind: ${short(error)}`);
      return { ok: false, message: "Uzib bo'lmadi, keyinroq urinib ko'ring." };
    }
  }

  /** Dispatch'da shaxsiy DM yo'li: TELEGRAM so'ralgan va guruh nishoni yo'q. */
  static wantsDm(
    channels: readonly string[],
    target?: { market_id?: string; group_id?: string } | null,
  ): boolean {
    return (
      channels.includes(NotificationChannel.TELEGRAM) &&
      !target?.market_id &&
      !target?.group_id
    );
  }
}
