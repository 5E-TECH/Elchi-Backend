import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { escapeTelegramHtml } from '@app/common';
import { TelegramOrderCard } from '../../entities/telegram-order-card.entity';
import { BotActionsService } from '../bot-actions.service';
import { BotGatewayClient, rethrowPasswordChange } from '../bot-gateway.client';
import { BotOutboxService } from '../bot-outbox.service';
import { BotTransportService } from '../bot-transport.service';
import type { BotContext } from '../handlers/bot-context';
import type { InlineKeyboardButton } from '../telegram.types';
import {
  COURIER_ACTIONS,
  OP_LABEL,
  cabinetButton,
  courierCardText,
  opsForStatus,
  toCourierOrderView,
  type CourierOp,
  type CourierOrderView,
} from './courier-cards';

export const COURIER_PAGE_SIZE = 10;

/** (h9newLsd #5) buyurtma boshqa kuryerga o'tdi / ko'rinmaydi. */
export const ORDER_NOT_YOURS_NOTE =
  'ℹ️ Bu buyurtma endi sizda emas — tugmalar olib tashlandi.';
/** Kuryerning "bugungi ishi" — yo'lda, kutilmoqda, mijoz kutilmoqda. */
export const COURIER_ACTIVE_STATUSES = [
  'waiting',
  'on the road',
  'waiting_customer',
] as const;
const PROOF_TIMEOUT_MS = 60_000;
/**
 * (BOT-3d) Kuryer amali kutish chegarasi — gateway'ning eng uzun RMQ
 * chegarasidan (60 s) KATTA: gateway javobi yo'qolib ketmasin.
 */
export const COURIER_OP_TIMEOUT_MS = 65_000;
/** (BOT-3d) Natija noma'lum (timeout / 502–504) — qayta bosish o'rniga tekshirish. */
export const COURIER_OP_UNKNOWN_TEXT =
  "⏳ Natija noma'lum — /ishim orqali buyurtma holatini tekshiring.";

export type CourierOpOutcome =
  | { kind: 'ok'; message: string }
  | { kind: 'pending'; message: string }
  | { kind: 'proof'; message: string }
  | { kind: 'denied'; message: string }
  | { kind: 'error'; message: string };

const OP_PATH: Record<CourierOp, (id: string) => string> = {
  sell: (id) => `/orders/sell/${id}`,
  cancel: (id) => `/orders/cancel/${id}`,
  cnd: (id) => `/orders/${id}/could-not-deliver`,
  rollback: (id) => `/orders/rollback/${id}`,
};

const OP_DONE: Record<CourierOp, string> = {
  sell: 'sotildi ✅',
  cancel: 'bekor qilindi ❌',
  cnd: "«mijoz kutilmoqda» holatiga o'tdi 🕗",
  rollback: '«kutilmoqda» holatiga qaytarildi ↩️',
};

const messageOf = (body: unknown): string => {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.map(String).join('; ')
      : '';
};

/**
 * (h9newLsd / MO2MLPGo / z2FRwu2c) Kuryer amallari — HAMMASI kuryerning o'z
 * JWT'si bilan MAVJUD gateway endpointlari orqali (BotGatewayClient); bot
 * buyurtma bazasiga o'zi yozmaydi. Doira (faqat o'z buyurtmalari, holat
 * mashinasi, isbot siyosati, extra-cost tasdig'i) — server tomonda.
 */
@Injectable()
export class CourierService {
  private readonly logger = new Logger(CourierService.name);
  readonly cabinetUrl: string;
  /** (MWYaqprw) Skan Mini App manzili — faqat https; bo'sh bo'lsa tugma yo'q. */
  readonly scannerUrl: string;

  constructor(
    private readonly gateway: BotGatewayClient,
    private readonly actions: BotActionsService,
    private readonly outbox: BotOutboxService,
    private readonly transport: BotTransportService,
    @InjectRepository(TelegramOrderCard)
    private readonly cards: Repository<TelegramOrderCard>,
    config: ConfigService,
  ) {
    this.cabinetUrl = String(
      config.get<string>('ELCHI_CABINET_URL') ?? 'https://admin.elchipochta.uz',
    ).trim();
    const scanner = String(
      config.get<string>('TELEGRAM_SCAN_WEBAPP_URL') ?? '',
    ).trim();
    this.scannerUrl = /^https:\/\/[^\s?#]+$/.test(scanner) ? scanner : '';
  }

  /** `GET /orders` (kuryer doirasi serverda: courier_ids = [o'zi]). */
  async listActive(
    telegramId: string,
    page: number,
  ): Promise<{ orders: CourierOrderView[]; total: number; hasNext: boolean }> {
    const query = new URLSearchParams();
    for (const status of COURIER_ACTIVE_STATUSES)
      query.append('status', status);
    query.set('page', String(Math.max(1, page)));
    query.set('limit', String(COURIER_PAGE_SIZE));
    const res = await this.gateway.request<Record<string, unknown>>(
      telegramId,
      'GET',
      `/orders?${query.toString()}`,
    );
    if (res.status >= 400 || !res.body) {
      throw new Error(`orders list HTTP ${res.status}`);
    }
    const body = res.body;
    const inner =
      body.data && !Array.isArray(body.data) && typeof body.data === 'object'
        ? (body.data as Record<string, unknown>)
        : body;
    const rows = Array.isArray(inner.data) ? (inner.data as unknown[]) : [];
    const orders = rows
      .map((row) => toCourierOrderView(row))
      .filter((row): row is CourierOrderView => Boolean(row));
    return {
      orders,
      total: Number(inner.total ?? orders.length) || orders.length,
      hasNext: Boolean(inner.has_next ?? inner.hasNext),
    };
  }

  /** `GET /orders/:id` (assertCanViewOrder — faqat o'z buyurtmasi). */
  async getOrder(
    telegramId: string,
    orderId: string,
  ): Promise<CourierOrderView | null> {
    const res = await this.gateway.request<unknown>(
      telegramId,
      'GET',
      `/orders/${encodeURIComponent(orderId)}`,
    );
    if (res.status >= 400) return null;
    const body = res.body as { data?: unknown } | null;
    return (
      toCourierOrderView(body && 'status' in body ? body : body?.data) ?? null
    );
  }

  /** Karta tugmalari: shu holatdan mumkin bo'lgan amallar + kabinet havolasi. */
  async cardKeyboard(
    ctx: Pick<BotContext, 'chatId'>,
    order: CourierOrderView,
    actorUserId: string,
  ): Promise<InlineKeyboardButton[][]> {
    const row: InlineKeyboardButton[] = [];
    for (const op of opsForStatus(order.status)) {
      row.push({
        text: OP_LABEL[op],
        callback_data: await this.actions.create({
          chatId: ctx.chatId,
          action: COURIER_ACTIONS.op,
          actorUserId,
          orderId: order.id,
          payload: { op },
          oneShot: false,
        }),
      });
    }
    const keyboard = row.length ? [row] : [];
    // (h9newLsd #6) partly-sell — TUGMA EMAS, kabinetda.
    if (order.status === 'waiting') {
      keyboard.push([cabinetButton(this.cabinetUrl, order.id)]);
    }
    return keyboard;
  }

  /** Kartani yuboradi va message_id ni saqlaydi (keyin tahrirlash uchun). */
  async sendCard(
    ctx: BotContext,
    order: CourierOrderView,
    actorUserId: string,
  ): Promise<void> {
    const keyboard = await this.cardKeyboard(ctx, order, actorUserId);
    const sent = await this.outbox.send({
      chatId: ctx.chatId,
      text: courierCardText(order),
      parse_mode: 'HTML',
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
      source: 'bot.courier_card',
    });
    const messageId = sent.result?.message_id;
    if (sent.status !== 'sent' || !messageId) return;
    const callbacks = keyboard
      .flat()
      .map((button) => button.callback_data)
      .filter((data): data is string => Boolean(data));
    await this.actions.attachMessage(callbacks, messageId);
    await this.cards.upsert(
      {
        order_id: order.id,
        chat_id: ctx.chatId,
        message_id: String(messageId),
        kind: 'courier',
        actor_user_id: actorUserId,
        status: order.status,
        updated_at: new Date(),
      },
      ['order_id', 'chat_id'],
    );
  }

  /** Amaldan keyin karta yangilanadi (yangi xabar emas). */
  async refreshCard(
    ctx: BotContext,
    telegramId: string,
    orderId: string,
    actorUserId: string,
    note?: string,
  ): Promise<void> {
    const card = await this.cards.findOne({
      where: { order_id: orderId, chat_id: ctx.chatId },
    });
    if (!card?.message_id) return;
    const messageId = card.message_id;
    const order = await this.getOrder(telegramId, orderId).catch(
      (error: unknown) => {
        rethrowPasswordChange(error);
        return null;
      },
    );
    if (!order) return;
    const keyboard = note
      ? []
      : await this.cardKeyboard(ctx, order, actorUserId);
    await this.transport.editMessage(ctx.chatId, messageId, {
      text: courierCardText(order, note),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
    await this.cards.update(
      { order_id: orderId, chat_id: ctx.chatId },
      { status: order.status, updated_at: new Date() },
    );
  }

  /**
   * (h9newLsd #5) Holat PANELDA / menejer tomonidan o'zgardi — kuryer
   * kartasi (shaxsiy chat: chat_id = kuryerning telegram id si) kuryerning
   * O'Z JWT'si bilan qayta o'qiladi va TAHRIRLANADI (yangi xabar emas).
   * Buyurtma endi unga ko'rinmasa (boshqa kuryerga o'tgan — 403/404) —
   * tugmalar olinadi va izoh qo'yiladi. Tarmoq xatosi — tegilmaydi.
   */
  async refreshCardForChat(
    chatId: string,
    orderId: string,
    actorUserId: string | null,
  ): Promise<'edited' | 'revoked' | 'skipped'> {
    const card = await this.cards.findOne({
      where: { order_id: orderId, chat_id: chatId },
    });
    // (BOT-3 #4) message_id'siz qator — faqat guruh kartasi «yuborilmoqda».
    if (!card?.message_id || !actorUserId) return 'skipped';
    const messageId = card.message_id;
    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request<unknown>(
        chatId,
        'GET',
        `/orders/${encodeURIComponent(orderId)}`,
      );
    } catch (error) {
      rethrowPasswordChange(error);
      return 'skipped';
    }
    if (res.status === 403 || res.status === 404) {
      await this.transport.editMessage(chatId, messageId, {
        text: `📦 <b>#${escapeTelegramHtml(orderId)}</b>\n${ORDER_NOT_YOURS_NOTE}`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
      await this.cards.update(
        { order_id: orderId, chat_id: chatId },
        { status: null, updated_at: new Date() },
      );
      return 'revoked';
    }
    if (res.status >= 400) return 'skipped';
    const body = res.body as { data?: unknown } | null;
    const order = toCourierOrderView(
      body && 'status' in body ? body : body?.data,
    );
    if (!order) return 'skipped';
    const keyboard = await this.cardKeyboard({ chatId }, order, actorUserId);
    await this.transport.editMessage(chatId, messageId, {
      text: courierCardText(order),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
    await this.cards.update(
      { order_id: orderId, chat_id: chatId },
      { status: order.status, updated_at: new Date() },
    );
    return 'edited';
  }

  /**
   * Amal — mavjud endpoint. Javob odamga tushunarli matnga aylanadi:
   * 202 → "Market tasdig'i kutilmoqda", isbot talabi → isbot rejimi, holat
   * rad etilsa → "Bu holatda bu amal mumkin emas".
   */
  async perform(
    telegramId: string,
    op: CourierOp,
    orderId: string,
    options: {
      reason?: string;
      proofFileKeys?: string[];
      idempotencyKey?: string;
    },
  ): Promise<CourierOpOutcome> {
    const body: Record<string, unknown> = {};
    if (op === 'cancel' && options.reason) body.reason = options.reason;
    if (op === 'cnd') body.reason = options.reason;
    if (options.proofFileKeys?.length)
      body.proofFileKeys = options.proofFileKeys;
    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request(
        telegramId,
        'POST',
        OP_PATH[op](encodeURIComponent(orderId)),
        body,
        {
          timeoutMs: COURIER_OP_TIMEOUT_MS,
          idempotencyKey: options.idempotencyKey,
        },
      );
    } catch (error) {
      rethrowPasswordChange(error);
      this.logger.warn(
        `courier ${op} #${orderId}: ${error instanceof Error ? error.message : 'error'}`,
      );
      // So'rov yuborilgan bo'lishi mumkin (javob kelmadi) — «bajarilmadi»
      // deyilmaydi; qayta bosilsa ham ayni kalit amalni takrorlamaydi.
      if (isTimeout(error)) {
        return { kind: 'error', message: COURIER_OP_UNKNOWN_TEXT };
      }
      return {
        kind: 'error',
        message:
          "❌ Amal bajarilmadi (aloqa xatosi) — birozdan so'ng qayta urinib ko'ring.",
      };
    }
    // Gateway / order-service javob bermadi (inglizcha 504 matni odamga
    // chiqmaydi) — natija noma'lum.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { kind: 'error', message: COURIER_OP_UNKNOWN_TEXT };
    }
    const text = messageOf(res.body);
    if (res.status === 202) {
      return {
        kind: 'pending',
        message: `⏳ #${orderId} — Market tasdig'i kutilmoqda (qo'shimcha xarajat).`,
      };
    }
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'ok', message: `#${orderId} — ${OP_DONE[op]}` };
    }
    if (/isbot majburiy/i.test(text)) {
      return {
        kind: 'proof',
        message: '📷 Bu amal uchun rasm yoki video isbot majburiy.',
      };
    }
    if (/isbot fayl topilmadi/i.test(text)) {
      return {
        kind: 'proof',
        message:
          '📷 Isbot fayli tasdiqlanmadi — rasm yoki videoni qayta yuboring.',
      };
    }
    if (res.status === 401) {
      return {
        kind: 'denied',
        message: "🔒 Avval Telegram'ni Elchi akkauntingizga ulang.",
      };
    }
    // (ZDweRm02) order-service xabari o'zbekcha («… kuryerga biriktirilmagan»);
    // eski inglizcha matn ham (rolling deploy) tan olinadi.
    if (res.status === 403 || /not assigned|biriktirilmagan/i.test(text)) {
      return {
        kind: 'denied',
        message: '🔒 Bu buyurtma sizga biriktirilmagan.',
      };
    }
    if (
      res.status === 400 &&
      /status|holat|Rollback mumkin emas|transition/i.test(text)
    ) {
      return { kind: 'denied', message: '⚠️ Bu holatda bu amal mumkin emas.' };
    }
    return {
      kind: 'error',
      message: `❌ Amal bajarilmadi${text ? `: ${text.slice(0, 200)}` : '.'}`,
    };
  }

  /**
   * (z2FRwu2c #2-#3) Isbot fayli → `POST /files/upload` (folder=proof,
   * kuryer JWT). Qaytgan kalit `proofFileKeys` ga; `proofFileKeysVerified`
   * ni bot O'RNATMAYDI — order-service har kalitni file-service'da tekshiradi.
   */
  async uploadProof(
    telegramId: string,
    file: { buffer: Buffer; mime: string; name: string },
  ): Promise<string> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
      file.name,
    );
    form.append('folder', 'proof');
    const res = await this.gateway.request<{ data?: { key?: string } }>(
      telegramId,
      'POST',
      '/files/upload',
      form,
      { timeoutMs: PROOF_TIMEOUT_MS },
    );
    const key = res.body?.data?.key;
    if (res.status >= 400 || !key) {
      throw new Error(`files/upload HTTP ${res.status}`);
    }
    return key;
  }
}

/** fetch `AbortSignal.timeout` — `TimeoutError` (yoki eski muhitda `AbortError`). */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
