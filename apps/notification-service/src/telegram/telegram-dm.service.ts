import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from '@nestjs/common';
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
import { TelegramLinkService } from '../bot/telegram-link.service';
import { BotActionsService } from '../bot/bot-actions.service';
import { BotTransportService } from '../bot/bot-transport.service';
import { botDmDeliveryTotal } from '../bot/bot-metrics';
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from '../bot/telegram.types';

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

/** Shaxsiy chat id si musbat; guruh / kanal id lari manfiy. */
const isPrivateChat = (chat: string) => /^\d{1,20}$/.test(chat);

/** Metrika yorlig'i — faqat katalog ko'rinishidagi tur (kardinallik cheklangan). */
const metricType = (type: unknown) => {
  const value = str(type).trim();
  return /^[a-z]+\.[a-z_]+$/.test(value) ? value : 'other';
};

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
/** (BOT-3c) Shundan eski blok — bitta sinov xabari (403 → blok yangilanadi). */
export const TELEGRAM_BLOCK_PROBE_DAYS = 30;

@Injectable()
export class TelegramDmService {
  private readonly logger = new Logger(TelegramDmService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly outbox: OutboxService,
    private readonly contacts: SmsDispatchService,
    // ⚠️ Aylanma import (notification-service.service ↔ inbox ↔ telegram-dm):
    // forwardRef bo'lmasa servis BOOT'da yiqiladi.
    @Inject(forwardRef(() => NotificationServiceService))
    private readonly telegram: NotificationServiceService,
    private readonly config: ConfigService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly links: TelegramLinkService,
    @Optional() private readonly actions?: BotActionsService,
    @Optional() private readonly transport?: BotTransportService,
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
  ) {}

  private get botToken(): string {
    return (this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '').trim();
  }

  /**
   * Har qabul qiluvchi uchun `delivery.telegram`: chat ulangan — `queued`,
   * ulanmagan — `skipped` + `telegram_reason: no_telegram_id` (dispatch
   * YIQILMAYDI), bot tokeni yo'q — `no_provider`.
   */
  async plan(recipientIds: string[], type = ''): Promise<TelegramDmPlan> {
    const plan: TelegramDmPlan = new Map();
    if (!recipientIds.length) return plan;
    const count = (status: string, n = 1) =>
      botDmDeliveryTotal.inc({ type: metricType(type), status }, n);
    if (!this.botToken) {
      for (const id of recipientIds)
        plan.set(id, { telegram: NotificationDeliveryStatus.NO_PROVIDER });
      count('no_provider', recipientIds.length);
      return plan;
    }
    let chats: Map<string, string>;
    try {
      chats = await this.chatIds(recipientIds);
    } catch (error) {
      this.logger.warn(`telegram DM: identity javob bermadi — ${short(error)}`);
      for (const id of recipientIds)
        plan.set(id, {
          telegram: NotificationDeliveryStatus.FAILED,
          telegram_error: 'contacts_unavailable',
        });
      count('failed', recipientIds.length);
      return plan;
    }
    const blocked = await this.blockedChats([...chats.values()]);
    for (const id of recipientIds) {
      const chat = chats.get(id) ?? '';
      const entry: Record<string, string> = !chat
        ? {
            telegram: NotificationDeliveryStatus.SKIPPED,
            telegram_reason: 'no_telegram_id',
          }
        : !isPrivateChat(chat)
          ? {
              // (2crjWf7v) DM — faqat shaxsiy chat; guruh id si hech qachon.
              telegram: NotificationDeliveryStatus.SKIPPED,
              telegram_reason: 'not_private_chat',
            }
          : blocked.has(chat)
            ? {
                // (9HIaV80X / 4BirMSVp) botni bloklagan chatga qayta urinilmaydi.
                telegram: NotificationDeliveryStatus.SKIPPED,
                telegram_reason: 'bot_blocked',
              }
            : { telegram: NotificationDeliveryStatus.QUEUED };
      plan.set(id, entry);
      count(
        entry.telegram === NotificationDeliveryStatus.QUEUED
          ? 'planned'
          : 'skipped',
      );
    }
    return plan;
  }

  /**
   * (TgYRqaTk #1) Qabul qiluvchi → shaxsiy chat: `identity.telegram.resolve_many`
   * (`user_ids`). Identity fail-closed: faol emas / ulanmagan / noaniq chat →
   * yo'q (xabar yuborilmaydi). Xato — chaqiruvchiga (plan: `failed`,
   * deliver: navbatga qaytariladi).
   */
  private async chatIds(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    const res = await rmqSend<{ data?: Record<string, unknown> }>(
      this.identityClient,
      { cmd: 'identity.telegram.resolve_many' },
      { user_ids: ids },
    );
    const data = res?.data;
    if (!data || typeof data !== 'object') {
      throw new Error('identity.telegram.resolve_many: javob yaroqsiz');
    }
    const map = new Map<string, string>();
    for (const id of ids) {
      const chat = str(data[id]).trim();
      if (/^-?\d{1,20}$/.test(chat)) map.set(id, chat);
    }
    return map;
  }

  /**
   * Botni bloklagan shaxsiy chatlar (`telegram_blocked_chats`, BOT-3c).
   * Zaxira: `my_chat_member: member` yangilanishi yo'qolsa odam DM'dan
   * abadiy uzilib qolmasin — `TELEGRAM_BLOCK_PROBE_DAYS` (30) kundan eski
   * blokda bitta xabar urinib ko'riladi; yana 403 bo'lsa blok yangilanadi.
   */
  private async blockedChats(chatIds: string[]): Promise<Set<string>> {
    if (!chatIds.length) return new Set();
    try {
      const rows: Array<{ chat_id: string }> = await this.notifications.query(
        `SELECT "chat_id" FROM "notification_schema"."telegram_blocked_chats"
          WHERE "chat_id" = ANY($1::varchar[])
            AND "blocked_at" > now() - ($2::int * interval '1 day')`,
        [chatIds, TELEGRAM_BLOCK_PROBE_DAYS],
      );
      return new Set(
        (Array.isArray(rows) ? rows : []).map((row) => String(row.chat_id)),
      );
    } catch (error) {
      this.logger.warn(`telegram DM: blok holati o'qilmadi — ${short(error)}`);
      return new Set();
    }
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
      data?: Record<string, unknown> | null;
      type?: string | null;
      link?: string | null;
    }> = await this.notifications.query(
      `UPDATE "notification_schema"."notifications"
          SET "delivery" = COALESCE("delivery", '{}'::jsonb) || '{"telegram":"sending"}'::jsonb
        WHERE "id" = ANY($1::bigint[])
          AND "delivery"->>'telegram' = 'queued'
      RETURNING "id", "recipient_id", "title", "body", "data", "type", "link"`,
      [ids],
    );
    const rows = Array.isArray(claimed[0])
      ? (claimed[0] as typeof claimed)
      : claimed;
    if (!rows.length) return { processed: 0, sent: 0, failed: 0 };

    let chats: Map<string, string>;
    try {
      chats = await this.chatIds(rows.map((row) => String(row.recipient_id)));
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
            type?: string | null;
            patch: Record<string, string>;
          }> => {
            const chat = chats.get(String(row.recipient_id)) ?? '';
            if (!chat || !isPrivateChat(chat)) {
              return {
                id: String(row.id),
                type: row.type,
                patch: {
                  telegram: NotificationDeliveryStatus.SKIPPED,
                  telegram_reason: chat ? 'not_private_chat' : 'no_telegram_id',
                },
              };
            }
            try {
              const reply_markup = await this.buttons(
                chat,
                String(row.recipient_id),
                row.data,
                row.link,
              );
              const status = await this.sendWithMedia(
                chat,
                this.text(row),
                row.data,
                reply_markup,
                String(row.id),
              );
              // (BOT-3c) 429/5xx — outbox qayta yuboradi: `sent` EMAS;
              // yakuniy holatni outbox ishchisi yozadi.
              return {
                id: String(row.id),
                type: row.type,
                patch: {
                  telegram:
                    status === 'queued'
                      ? NotificationDeliveryStatus.RETRYING
                      : NotificationDeliveryStatus.SENT,
                },
              };
            } catch (error) {
              const reason = short(error);
              return {
                id: String(row.id),
                type: row.type,
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
        botDmDeliveryTotal.inc({
          type: metricType(result.type),
          status: result.patch.telegram,
        });
        await this.patch([result.id], result.patch);
      }
    }
    return { processed: rows.length, sent, failed };
  }

  /**
   * Bildirishnoma `data.telegram_buttons` → inline klaviatura (shaxsiy DM):
   * `{text, url}` (faqat https) yoki `{text, action, payload}` — bot amali
   * (`a:<id>`, egasi = qabul qiluvchi: boshqa odam bosa olmaydi). Holat
   * DB'da (telegram_bot_actions), payload'da PII yo'q.
   */
  private async buttons(
    chatId: string,
    recipientId: string,
    data: Record<string, unknown> | null | undefined,
    link?: string | null,
  ): Promise<InlineKeyboardMarkup | null> {
    const cabinet = this.cabinetButton(data, link);
    const spec = data?.telegram_buttons;
    if (!Array.isArray(spec) || !this.actions) {
      return cabinet ? { inline_keyboard: [[cabinet]] } : null;
    }
    const rows: InlineKeyboardButton[][] = [];
    for (const rawRow of spec.slice(0, 5)) {
      const row: InlineKeyboardButton[] = [];
      for (const raw of (Array.isArray(rawRow) ? rawRow : [rawRow]).slice(
        0,
        4,
      )) {
        const button = raw as {
          text?: unknown;
          url?: unknown;
          action?: unknown;
          payload?: unknown;
          one_shot?: unknown;
          order_id?: unknown;
        };
        const label = str(button.text).slice(0, 64);
        if (!label) continue;
        if (typeof button.url === 'string' && /^https:\/\//.test(button.url)) {
          row.push({ text: label, url: button.url });
        } else if (typeof button.action === 'string' && button.action) {
          row.push({
            text: label,
            callback_data: await this.actions.create({
              chatId,
              action: button.action.slice(0, 32),
              actorUserId: recipientId,
              orderId: str(button.order_id) || null,
              payload:
                button.payload && typeof button.payload === 'object'
                  ? (button.payload as Record<string, unknown>)
                  : {},
              oneShot: button.one_shot !== false,
            }),
          });
        }
      }
      if (row.length) rows.push(row);
    }
    if (cabinet) rows.push([cabinet]);
    return rows.length ? { inline_keyboard: rows } : null;
  }

  /**
   * (VICfJuoi #3) `data.telegram_cabinet_link: true` — bildirishnoma `link`
   * (nisbiy yo'l, masalan `/cash-box`) panel manzili bilan "🌐 Kabinetda
   * ochish" tugmasi bo'ladi. Tafsilot (tarix, filtr) brauzerda qoladi.
   */
  private cabinetButton(
    data: Record<string, unknown> | null | undefined,
    link: string | null | undefined,
  ): InlineKeyboardButton | null {
    if (data?.telegram_cabinet_link !== true) return null;
    const path = typeof link === 'string' ? link.trim() : '';
    if (!/^\/[\w\-./?=&%]*$/.test(path)) return null;
    const base = (
      this.config.get<string>('ELCHI_CABINET_URL') ??
      'https://admin.elchipochta.uz'
    ).replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) return null;
    return { text: '🌐 Kabinetda ochish', url: `${base}${path}` };
  }

  /**
   * (DuST9k8j) `data.telegram_media` — file-service kalitlari (isbot). BITTA
   * fayl: rasm/video + matn + tugmalar BITTA postda; KO'P: albom (≤10) +
   * tugmalar ALOHIDA xabarda (Telegram albomga tugma qo'ydirmaydi). Fayl
   * o'qilmasa / yuborilmasa — oddiy matnli xabar (yetkazish yiqilmaydi).
   * Tugmali xabar `message_id` si bot amallariga biriktiriladi (qarordan
   * keyin tahrirlash uchun).
   */
  private async sendWithMedia(
    chat: string,
    text: string,
    data: Record<string, unknown> | null | undefined,
    reply_markup: InlineKeyboardMarkup | null,
    notificationId: string,
  ): Promise<'sent' | 'queued'> {
    let status: 'sent' | 'queued' = 'sent';
    const keys = Array.isArray(data?.telegram_media)
      ? (data.telegram_media as unknown[])
          .map((key) => str(key))
          .filter(Boolean)
      : [];
    let messageId: number | null = null;
    let textNeeded = true;
    let albumSent = false;
    if (keys.length && this.transport && this.fileClient) {
      const files = await this.readFiles(keys.slice(0, 10));
      if (files.length) {
        try {
          messageId = await this.transport.sendMedia(
            chat,
            files,
            files.length === 1
              ? {
                  caption: text,
                  parse_mode: 'HTML',
                  ...(reply_markup ? { reply_markup } : {}),
                }
              : { caption: text, parse_mode: 'HTML' },
          );
          albumSent = files.length > 1;
          textNeeded = albumSent;
        } catch (error) {
          this.logger.warn(
            `telegram DM media: ${short(error)} — matn bilan yuboriladi`,
          );
        }
      }
    }
    if (textNeeded) {
      const sent = await this.telegram.sendDirectToGroup({
        group_id: chat,
        // Albomdan keyin — faqat tugmalar xabari (matn albom izohida).
        message: albumSent ? '⬆️ Isbot fayllari yuqorida. Qaroringiz:' : text,
        parse_mode: 'HTML',
        ...(reply_markup ? { reply_markup } : {}),
        source: 'notification.dm',
        notification_ids: [notificationId],
      });
      if ((sent as { status?: string })?.status === 'queued') status = 'queued';
      messageId =
        (sent as { result?: { message_id?: number } | null })?.result
          ?.message_id ?? messageId;
    }
    if (reply_markup && messageId && this.actions) {
      const callbacks = reply_markup.inline_keyboard
        .flat()
        .map((button) => button.callback_data)
        .filter((value): value is string => Boolean(value));
      await this.actions
        .attachMessage(callbacks, messageId)
        .catch(() => undefined);
    }
    return status;
  }

  private async readFiles(
    keys: string[],
  ): Promise<Array<{ buffer: Buffer; mime: string; name: string }>> {
    const files: Array<{ buffer: Buffer; mime: string; name: string }> = [];
    for (const key of keys) {
      try {
        const res = await rmqSend<{
          data?: { body_base64?: string; mime_type?: string };
        }>(
          this.fileClient!,
          { cmd: 'file.read' },
          { key },
          { timeoutMs: 20_000 },
        );
        const base64 = res?.data?.body_base64;
        if (!base64) continue;
        const buffer = Buffer.from(base64, 'base64');
        // Telegram bot API yuklash chegarasi (50MB) — kattasi o'tkaziladi.
        if (buffer.length > 49 * 1024 * 1024) continue;
        files.push({
          buffer,
          mime: str(res?.data?.mime_type) || 'application/octet-stream',
          name: key.split('/').pop()?.slice(-60) || 'proof',
        });
      } catch (error) {
        this.logger.warn(`isbot fayli o'qilmadi: ${short(error)}`);
      }
    }
    return files;
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
    const query = this.notifications
      .createQueryBuilder()
      .update(Notification)
      .set({
        delivery: () => `COALESCE("delivery", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .whereInIds(ids);
    // (BOT-3c) `retrying` — faqat hali `sending` bo'lsa: outbox ishchisi
    // yakuniy holatni allaqachon yozgan bo'lsa, bosib ketilmaydi.
    if (patch.telegram === NotificationDeliveryStatus.RETRYING) {
      query.andWhere(`"delivery"->>'telegram' = 'sending'`);
    }
    await query.execute();
  }

  // ==================== ulash (9uNhwTZp / 6jXw0DDr / 4TfLyTrL) ====================

  private get botUsername(): string {
    return (this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? '')
      .trim()
      .replace(/^@/, '');
  }

  /**
   * `POST /notifications/telegram/link` (eski) — `purpose: user` bilan bir
   * xil; endi HMAC emas, BIR MARTALIK DB kodi (10 daqiqa).
   */
  linkToken(input: { user_id?: unknown; roles?: unknown; ip?: unknown }) {
    return this.issueLinkCode({
      purpose: 'user',
      requester: { id: input?.user_id, roles: input?.roles },
      ip: input?.ip,
    });
  }

  /**
   * (6jXw0DDr #5 / 4TfLyTrL #3-#4 / 9uNhwTZp #3) Panel → bir martalik kod.
   *  - `user` — o'z akkauntiga (JWT'dagi id), `t.me/<bot>?start=<kod>`;
   *  - `market_group` — market guruhi: market o'zi, market operatori o'z
   *    marketi (identity'dan), admin/superadmin — `market_id` bilan;
   *    `t.me/<bot>?startgroup=<kod>`.
   * Mijoz va investor kod olmaydi.
   */
  async issueLinkCode(input: {
    purpose?: unknown;
    requester?: { id?: unknown; roles?: unknown };
    market_id?: unknown;
    group_type?: unknown;
    ip?: unknown;
  }) {
    const userId = str(input?.requester?.id).trim();
    if (!/^\d{1,19}$/.test(userId)) {
      throw new RpcException({ statusCode: 401, message: 'Unauthorized' });
    }
    if (!this.botToken) {
      throw new RpcException({
        statusCode: 503,
        message: 'Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN)',
      });
    }
    const roles = (
      Array.isArray(input?.requester?.roles)
        ? (input.requester.roles as unknown[])
        : []
    ).map((role) => str(role).toLowerCase());
    if (
      !roles.length ||
      roles.some((r) => ['customer', 'investor'].includes(r))
    ) {
      throw new RpcException({
        statusCode: 403,
        message: 'Bu rol Telegram botiga ulanmaydi',
      });
    }
    const purpose = str(input?.purpose || 'user');
    const ip = str(input?.ip).slice(0, 64) || null;
    if (purpose === 'user') {
      const { token, expires_at } = await this.links.issue({
        purpose: 'user',
        owner_type: roles[0],
        owner_id: userId,
        created_by: userId,
        created_ip: ip,
      });
      return this.linkResponse(token, expires_at, 'user');
    }
    if (purpose !== 'market_group') {
      throw new RpcException({
        statusCode: 400,
        message: "purpose — 'user' yoki 'market_group'",
      });
    }
    const groupType = str(input?.group_type || 'create');
    if (!['create', 'cancel'].includes(groupType)) {
      throw new RpcException({
        statusCode: 400,
        message: "group_type — 'create' yoki 'cancel'",
      });
    }
    const marketId = await this.resolveGroupMarket(
      userId,
      roles,
      str(input?.market_id).trim(),
    );
    const { token, expires_at } = await this.links.issue({
      purpose: 'market_group',
      owner_type: 'market',
      owner_id: marketId,
      group_type: groupType,
      created_by: userId,
      created_ip: ip,
    });
    return this.linkResponse(token, expires_at, 'market_group', groupType);
  }

  /** Guruh kimning marketiga ulanadi — so'rovchi roli bo'yicha, server tomonda. */
  private async resolveGroupMarket(
    userId: string,
    roles: string[],
    requested: string,
  ): Promise<string> {
    if (requested && !/^\d{1,19}$/.test(requested)) {
      throw new RpcException({
        statusCode: 400,
        message: "market_id noto'g'ri",
      });
    }
    if (roles.includes('superadmin') || roles.includes('admin')) {
      if (!requested) {
        throw new RpcException({
          statusCode: 400,
          message: 'market_id majburiy',
        });
      }
      return requested;
    }
    /**
     * (BOT-2 #5, ega qarori Q2 = A) Market guruhini faqat market EGASI yoki
     * admin ulaydi. Operator endi ulay olmaydi: guruhga kartalar (mijoz
     * ma'lumoti bilan) ketadi, ega kim qo'shilganini nazorat qilishi kerak.
     */
    const own = roles.includes('market') ? userId : '';
    if (!own) {
      throw new RpcException({
        statusCode: 403,
        message: 'Guruhni faqat market egasi yoki admin ulay oladi',
      });
    }
    if (requested && requested !== own) {
      throw new RpcException({
        statusCode: 403,
        message: "Faqat o'z marketingiz guruhini ulay olasiz",
      });
    }
    return own;
  }

  private linkResponse(
    token: string,
    expiresAt: Date,
    purpose: 'user' | 'market_group',
    groupType?: string,
  ) {
    const username = this.botUsername;
    const param = purpose === 'user' ? 'start' : 'startgroup';
    return {
      statusCode: 200,
      message: 'Telegram link',
      data: {
        token,
        purpose,
        ...(groupType ? { group_type: groupType } : {}),
        expires_at: expiresAt,
        deep_link: username
          ? `https://t.me/${username}?${param}=${token}`
          : null,
        // Havola bo'lmasa: botga (guruhda — botni qo'shib) shu buyruq.
        command: `/start ${token}`,
      },
    };
  }

  /**
   * Bot `/start <kod>` (FAQAT shaxsiy chat): kod ATOMIK band qilinadi, so'ng
   * identity `telegram.link` (konflikt / faollik / rol tekshiruvlari).
   */
  async bindFromStart(
    payload: string,
    chatId: string,
    telegramUsername?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const claim = await this.links.claim(payload, 'private', chatId);
    if (claim.status !== 'ok' || claim.token.purpose !== 'user') {
      return {
        ok: false,
        message:
          claim.status === 'wrong_scope'
            ? "Bu havola guruh uchun — botni guruhga qo'shing."
            : "Havola eskirgan yoki allaqachon ishlatilgan. Elchi profilingizdan «Telegram'ni ulash» ni qayta bosing.",
      };
    }
    try {
      await rmqSend(
        this.identityClient,
        { cmd: 'identity.telegram.link' },
        {
          user_id: String(claim.token.owner_id),
          telegram_id: chatId,
          telegram_username: telegramUsername ?? null,
        },
      );
    } catch (error) {
      const status = Number(
        (error as { statusCode?: unknown } | null)?.statusCode ??
          (error as { error?: { statusCode?: unknown } } | null)?.error
            ?.statusCode,
      );
      this.logger.warn(`telegram link: ${short(error)}`);
      if (status === 409 || status === 403) {
        return { ok: false, message: `❌ ${short(error)}` };
      }
      return {
        ok: false,
        message: "Ulab bo'lmadi, keyinroq qayta urinib ko'ring.",
      };
    }
    return {
      ok: true,
      message:
        'Telegram ulandi ✅ Endi Elchi bildirishnomalari shu chatga ham keladi. Uzish: /uzish',
    };
  }

  /** Bot `/stop` | `/uzish` — shu chat ulangan akkauntlardan uziladi. */
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
