import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Roles,
} from '@app/common';
import { NotificationInboxService } from '../../notification-inbox.service';
import type { TelegramBotAction } from '../../entities/telegram-bot-action.entity';
import { BotActionsService } from '../bot-actions.service';
import { BotGatewayClient, rethrowPasswordChange } from '../bot-gateway.client';
import {
  BOT_MEDIA_LIMITS,
  MEDIA_SEND_AS_PHOTO_TEXT,
  pickPhotoSize,
} from '../bot-media';
import { BotSessionService } from '../bot-session.service';
import { BotTransportService } from '../bot-transport.service';
import type {
  BotActionHandler,
  BotContext,
  BotMessageHandler,
} from '../handlers/bot-context';
import type { InlineKeyboardButton } from '../telegram.types';
import {
  CANCEL_REASONS,
  CND_REASONS,
  COURIER_ACTIONS,
  COURIER_LIST_EXPIRED_TEXT,
  OP_LABEL,
  STATUS_LABEL_UZ,
  cabinetButton,
  cancelReasonValid,
  cndReasonText,
  formatSum,
  proofRequired,
  type CourierOp,
} from './courier-cards';
import {
  COURIER_OP_UNKNOWN_TEXT,
  COURIER_PAGE_SIZE,
  CourierService,
} from './courier.service';

/** (BOT-3d) Uzoq amal — spinner darhol shu matn bilan o'chiriladi. */
export const COURIER_OP_ACK_TEXT = '⏳ Bajarilmoqda…';
/** (BOT-3d) Natija noma'lum — «✅ Ha» ayni kalit bilan qayta yuboriladi. */
export const COURIER_OP_UNKNOWN_RETRY_TEXT =
  "⏳ Natija noma'lum. Tugmani («✅ Ha» / «✅ Tugatdim») qayta bosing — amal takrorlanmaydi; yoki /ishim orqali holatni tekshiring.";

/** (z2FRwu2c #6) bitta amalga ko'pi bilan 3 ta isbot fayli. */
export const PROOF_MAX_FILES = 3;
const PROOF_IMAGE_MIME = ['image/jpeg', 'image/png'];
const PROOF_VIDEO_MIME = ['video/mp4', 'video/quicktime'];

export const PROOF_PROMPT_TEXT =
  '📷 Rasm yoki video yuboring (3 tagacha). Hammasini yuborgach «✅ Tugatdim» ni bosing.';
export const PROOF_TOO_LARGE_TEXT =
  '❌ Video juda katta (Telegram bot 20MB gacha qabul qiladi) — qisqaroq oling yoki kabinetdan yuklang. Amal hali OCHIQ.';
export const PROOF_FORMAT_TEXT =
  '❌ Format qabul qilinmaydi — JPG/PNG surat yoki MP4/MOV video yuboring.';

interface ProofState {
  op: CourierOp;
  order_id: string;
  reason?: string | null;
  keys: string[];
}

const OPS: readonly CourierOp[] = ['sell', 'cancel', 'cnd', 'rollback'];
const isOp = (value: unknown): value is CourierOp =>
  typeof value === 'string' && (OPS as readonly string[]).includes(value);
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/**
 * Kuryer va market (pull) buyruqlari: `/ishim` (h9newLsd), `/kun`
 * (4BirMSVp), `/kassa` (kuryer kassasi), `/balans` (VICfJuoi #2 — market
 * FOR_MARKET kassasi). Rol darvozasi (CommandGateHandler) oldinroq o'tgan:
 * bu yerga faqat shaxsiy chatdagi to'g'ri rol keladi.
 */
@Injectable()
export class CourierHandler implements BotMessageHandler {
  private readonly logger = new Logger(CourierHandler.name);

  constructor(
    private readonly courier: CourierService,
    private readonly gateway: BotGatewayClient,
    private readonly sessions: BotSessionService,
    private readonly transport: BotTransportService,
    private readonly actions: BotActionsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(ctx: BotContext): Promise<boolean> {
    const match = /^\/(ishim|kun|kassa|balans)(?:@\w+)?$/i.exec(ctx.text);
    if (!match || !ctx.isPrivate || !ctx.fromId) return false;
    const actor = await ctx.actor();
    if (!actor) return false;
    const command = match[1].toLowerCase();
    try {
      if (command === 'ishim') await this.sendPage(ctx, 1);
      else if (command === 'kun') await this.dailyReport(ctx);
      else await this.cashbox(ctx, actor.role === Roles.COURIER);
    } catch (error) {
      rethrowPasswordChange(error);
      this.logger.warn(
        `/${command}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await ctx.reply(
        "❌ Ma'lumotni olib bo'lmadi — birozdan so'ng qayta urinib ko'ring.",
      );
    }
    return true;
  }

  /** (h9newLsd #2-#3) Bugungi topshiriqlar: tuman bo'yicha, 10 tadan, "⬇️ Yana". */
  /**
   * (BOT-3d) `/ishim` — BITTA ro'yxat xabari (avval sarlavha + 10 karta +
   * «Yana» = 12 xabar edi, shaxsiy chat chegarasida 429). Har buyurtma uchun
   * tugma — karta faqat bosilganda ochiladi; «⬇️ Yana» / «⬆️ Oldingi» shu
   * xabarni TAHRIRLAYDI (`editMessageId`).
   */
  async sendPage(
    ctx: BotContext,
    page: number,
    editMessageId?: number | string,
  ): Promise<void> {
    const actor = await ctx.actor();
    if (!actor || !ctx.fromId) return;
    const { orders, total, hasNext } = await this.courier.listActive(
      ctx.fromId,
      page,
    );
    if (!orders.length) {
      await ctx.reply(
        page === 1
          ? "✅ Hozircha faol topshiriq yo'q."
          : "Boshqa topshiriq yo'q.",
        page === 1 ? this.scannerMarkup() : undefined,
      );
      return;
    }
    const byDistrict = new Map<string, number>();
    for (const order of orders) {
      const key = order.district ?? "Tuman ko'rsatilmagan";
      byDistrict.set(key, (byDistrict.get(key) ?? 0) + 1);
    }
    const sorted = [...orders].sort((a, b) =>
      (a.district ?? '').localeCompare(b.district ?? ''),
    );
    const shownFrom = (page - 1) * COURIER_PAGE_SIZE;
    const text = [
      `📋 Topshiriqlar: jami ${total} ta (${page}-sahifa)`,
      ...[...byDistrict.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([district, count]) => `📍 ${district} — ${count} ta`),
      '',
      ...sorted.map(
        (order, index) =>
          `${shownFrom + index + 1}. #${order.id} — ${order.district ?? '—'} — ${STATUS_LABEL_UZ[order.status] ?? order.status}`,
      ),
      '',
      `Ko'rsatildi: ${shownFrom + orders.length} / ${total}. Kartani ochish — buyurtma tugmasi.`,
    ].join('\n');
    const keyboard: InlineKeyboardButton[][] = [];
    for (let i = 0; i < sorted.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (const order of sorted.slice(i, i + 2)) {
        row.push({
          text: `#${order.id}`,
          callback_data: await this.actions.create({
            chatId: ctx.chatId,
            action: COURIER_ACTIONS.open,
            actorUserId: actor.user_id,
            orderId: order.id,
            oneShot: false,
          }),
        });
      }
      keyboard.push(row);
    }
    const nav: InlineKeyboardButton[] = [];
    if (page > 1) {
      nav.push({
        text: '⬆️ Oldingi',
        callback_data: await this.actions.create({
          chatId: ctx.chatId,
          action: COURIER_ACTIONS.page,
          actorUserId: actor.user_id,
          payload: { page: page - 1, nav: true },
          oneShot: false,
        }),
      });
    }
    if (hasNext) {
      nav.push({
        text: '⬇️ Yana',
        callback_data: await this.actions.create({
          chatId: ctx.chatId,
          action: COURIER_ACTIONS.page,
          actorUserId: actor.user_id,
          payload: { page: page + 1, nav: true },
          oneShot: false,
        }),
      });
    }
    if (nav.length) keyboard.push(nav);
    const scanner = this.scannerMarkup()?.reply_markup.inline_keyboard ?? [];
    if (page === 1) keyboard.push(...scanner);
    if (editMessageId) {
      const edited = await this.transport.editMessage(
        ctx.chatId,
        editMessageId,
        { text, reply_markup: { inline_keyboard: keyboard } },
      );
      if (edited) return;
    }
    await ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
  }

  private scannerMarkup() {
    const url = this.courier.scannerUrl;
    return url
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: '📷 Skaner', web_app: { url } }]],
          },
        }
      : undefined;
  }

  /**
   * (4BirMSVp) `/kun` — mavjud manbalar: `GET /analytics/dashboard?period=today`
   * (`myStat`, kun chegarasi Asia/Tashkent serverda) va
   * `GET /finance/cashbox/my-cashbox`. Xabarni bot O'ZI yuborMAYDI —
   * `notification.dispatch` (in-app + Telegram DM) orqali.
   */
  async dailyReport(ctx: BotContext): Promise<void> {
    const actor = await ctx.actor();
    if (!actor || !ctx.fromId) return;
    const report = await buildCourierDailyReport(this.gateway, ctx.fromId);
    const inbox = this.moduleRef.get(NotificationInboxService, {
      strict: false,
    });
    await inbox.dispatch({
      type: 'courier.daily_report',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.NORMAL,
      title: '📊 Bugungi hisobot',
      body: report,
      recipient_id: actor.user_id,
      channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
      data: {
        telegram_buttons: [
          [{ text: '🌐 Kabinetda ochish', url: this.courier.cabinetUrl }],
        ],
      },
    } as never);
  }

  /** `/kassa` (kuryer) va `/balans` (market) — o'z kassasi, o'z JWT bilan. */
  async cashbox(ctx: BotContext, courier: boolean): Promise<void> {
    if (!ctx.fromId) return;
    const res = await this.gateway.request<{
      data?: {
        cashbox?: {
          balance?: unknown;
          balance_cash?: unknown;
          balance_card?: unknown;
        };
      };
    }>(ctx.fromId, 'GET', '/finance/cashbox/my-cashbox');
    const cashbox = res.body?.data?.cashbox;
    if (res.status >= 400 || !cashbox) {
      throw new Error(`my-cashbox HTTP ${res.status}`);
    }
    await ctx.reply(
      [
        courier ? '💰 Kassangizda:' : '💰 Balans (market kassasi):',
        `Jami: ${formatSum(cashbox.balance)}`,
        `Naqd: ${formatSum(cashbox.balance_cash)}`,
        `Karta: ${formatSum(cashbox.balance_card)}`,
      ].join('\n'),
    );
  }

  /**
   * (z2FRwu2c) Isbot rejimida kelgan media: har fayl uchun ANIQ javob
   * (qabul qilindi / juda katta / format noto'g'ri) — jim qolish taqiqlangan.
   * Isbot rejimi bo'lmasa `false` (router umumiy media javobini beradi).
   */
  async handleMedia(ctx: BotContext): Promise<boolean> {
    if (!ctx.isPrivate || !ctx.fromId) return false;
    const session = await ctx.session();
    const proof = session.state.proof as ProofState | undefined;
    if (!proof) return false;
    const message = ctx.update.message;
    if (proof.keys.length >= PROOF_MAX_FILES) {
      await ctx.reply(
        `Ko'pi bilan ${PROOF_MAX_FILES} ta fayl. «✅ Tugatdim» ni bosing.`,
      );
      return true;
    }
    let file: { id: string; mime: string; name: string; size: number | null };
    if (message?.photo?.length) {
      const size = pickPhotoSize(message.photo);
      if (!size) {
        await ctx.reply(MEDIA_SEND_AS_PHOTO_TEXT);
        return true;
      }
      file = {
        id: size.file_id,
        mime: 'image/jpeg',
        name: 'proof.jpg',
        size: size.file_size ?? null,
      };
    } else {
      const media = message?.video ?? message?.document;
      if (!media?.file_id) return false;
      const mime = String(
        media.mime_type ?? (message?.video ? 'video/mp4' : ''),
      ).toLowerCase();
      const size = media.file_size ?? null;
      if (size !== null && size > BOT_MEDIA_LIMITS.FILE_MAX_BYTES) {
        await ctx.reply(PROOF_TOO_LARGE_TEXT, {
          reply_markup: {
            inline_keyboard: [
              [cabinetButton(this.courier.cabinetUrl, proof.order_id)],
            ],
          },
        });
        return true;
      }
      if (mime.startsWith('image/') && !PROOF_IMAGE_MIME.includes(mime)) {
        await ctx.reply(MEDIA_SEND_AS_PHOTO_TEXT);
        return true;
      }
      if (![...PROOF_IMAGE_MIME, ...PROOF_VIDEO_MIME].includes(mime)) {
        await ctx.reply(PROOF_FORMAT_TEXT);
        return true;
      }
      if (
        PROOF_IMAGE_MIME.includes(mime) &&
        size !== null &&
        size > BOT_MEDIA_LIMITS.PHOTO_MAX_BYTES
      ) {
        await ctx.reply(MEDIA_SEND_AS_PHOTO_TEXT);
        return true;
      }
      const ext = mime === 'video/quicktime' ? 'mov' : mime.split('/')[1];
      file = { id: media.file_id, mime, name: `proof.${ext}`, size };
    }
    try {
      const { buffer } = await this.transport.downloadFile(file.id);
      const key = await this.courier.uploadProof(ctx.fromId, {
        buffer,
        mime: file.mime,
        name: file.name,
      });
      const updated = await this.sessions.update(ctx.chatId, ctx.slug, (s) => {
        const current = (s.state.proof as ProofState | undefined) ?? proof;
        return {
          state: {
            ...s.state,
            proof: { ...current, keys: [...current.keys, key] },
          },
        };
      });
      const count = (updated.state.proof as ProofState).keys.length;
      await ctx.reply(
        `✅ Qabul qilindi (${count}/${PROOF_MAX_FILES}). Yana yuboring yoki «✅ Tugatdim» ni bosing.`,
      );
    } catch (error) {
      rethrowPasswordChange(error);
      this.logger.warn(
        `isbot yuklash: ${error instanceof Error ? error.message : String(error)}`,
      );
      await ctx.reply(
        "❌ Faylni yuklab bo'lmadi — qayta yuboring yoki kabinetdan yuklang. Amal hali OCHIQ.",
        {
          reply_markup: {
            inline_keyboard: [
              [cabinetButton(this.courier.cabinetUrl, proof.order_id)],
            ],
          },
        },
      );
    }
    return true;
  }
}

/** /kun va avtomatik hisobot uchun umumiy matn (raqamlar Number() bilan). */
export async function buildCourierDailyReport(
  gateway: BotGatewayClient,
  telegramId: string,
): Promise<string> {
  const [stats, cash] = await Promise.all([
    gateway.request<{ data?: { myStat?: Record<string, unknown> } }>(
      telegramId,
      'GET',
      '/analytics/dashboard?period=today',
    ),
    gateway.request<{ data?: { cashbox?: { balance?: unknown } } }>(
      telegramId,
      'GET',
      '/finance/cashbox/my-cashbox',
    ),
  ]);
  if (stats.status >= 400) throw new Error(`dashboard HTTP ${stats.status}`);
  const my = stats.body?.data?.myStat ?? {};
  const num = (value: unknown) => {
    const parsed = Number(
      typeof value === 'string' || typeof value === 'number' ? value : 0,
    );
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const balance = cash.status < 400 ? cash.body?.data?.cashbox?.balance : null;
  return [
    `Jami: ${num(my.totalOrders)}, sotildi: ${num(my.soldOrders)}, bekor: ${num(my.canceledOrders)}`,
    `Muvaffaqiyat: ${Math.round(num(my.successRate) * 10) / 10}%`,
    `Daromad: ${formatSum(num(my.profit))}`,
    `💰 Kassada: ${balance === null || balance === undefined ? '—' : formatSum(balance)}`,
  ].join('\n');
}

/**
 * Kuryer tugmalari (MO2MLPGo / z2FRwu2c / h9newLsd). Router aktorni
 * `callback_query.from.id` bo'yicha tekshiradi (tugma kimga berilgan bo'lsa
 * faqat u), `answerCallbackQuery` ni ishdan OLDIN chaqiradi; bu yerda —
 * faqat shaxsiy chat (guruhdan kelgan holat callback'i rad).
 */
@Injectable()
export class CourierActions {
  readonly handlers: BotActionHandler[];

  constructor(
    private readonly courier: CourierService,
    private readonly actions: BotActionsService,
    private readonly sessions: BotSessionService,
    private readonly handler: CourierHandler,
    /** (BOT-3d) natijani tasdiq xabariga yozish; yo'q bo'lsa — yangi xabar. */
    @Optional() private readonly transport?: BotTransportService,
  ) {
    const privateOnly =
      (fn: (ctx: BotContext, action: TelegramBotAction) => Promise<void>) =>
      async (ctx: BotContext, action: TelegramBotAction) => {
        if (!ctx.isPrivate || !ctx.fromId) {
          await ctx.reply(
            '🔒 Buyurtma amallari faqat bot bilan SHAXSIY chatda.',
          );
          return;
        }
        await fn(ctx, action);
      };
    this.handlers = [
      {
        action: COURIER_ACTIONS.op,
        expiredText: COURIER_LIST_EXPIRED_TEXT,
        handle: privateOnly((ctx, action) => this.onOp(ctx, action)),
      },
      {
        action: COURIER_ACTIONS.reason,
        expiredText: COURIER_LIST_EXPIRED_TEXT,
        handle: privateOnly((ctx, action) => this.onReason(ctx, action)),
      },
      {
        action: COURIER_ACTIONS.confirm,
        expiredText: COURIER_LIST_EXPIRED_TEXT,
        ackText: COURIER_OP_ACK_TEXT,
        // (BOT-3d) Amal `action_id` kaliti bilan (Idempotency-Key) — qayta
        // ochilgan «✅ Ha» backend'da ikkinchi amal bermaydi.
        retrySafe: true,
        handle: privateOnly((ctx, action) => this.onConfirm(ctx, action)),
      },
      {
        action: COURIER_ACTIONS.back,
        handle: privateOnly((ctx) =>
          ctx.reply('⬅️ Amal bekor qilindi.').then(() => undefined),
        ),
      },
      {
        action: COURIER_ACTIONS.page,
        expiredText: COURIER_LIST_EXPIRED_TEXT,
        handle: privateOnly((ctx, action) =>
          this.handler.sendPage(
            ctx,
            Number(action.payload.page) || 1,
            // (BOT-3d) Faqat ro'yxatning o'z ⬆️/⬇️ tugmasi shu xabarni
            // tahrirlaydi; boshqa xabardagi «📋 Topshiriqlarim» (masalan skan
            // xulosasi) — yangi ro'yxat xabari, xulosa yo'qolmaydi.
            action.payload.nav === true
              ? ctx.update.callback_query?.message?.message_id
              : undefined,
          ),
        ),
      },
      {
        action: COURIER_ACTIONS.open,
        expiredText: COURIER_LIST_EXPIRED_TEXT,
        handle: privateOnly((ctx, action) => this.onOpen(ctx, action)),
      },
      {
        action: COURIER_ACTIONS.proofDone,
        ackText: COURIER_OP_ACK_TEXT,
        // Isbot urinishi kaliti (nonce) — release va qayta urinishda o'zgarmaydi.
        retrySafe: true,
        handle: privateOnly((ctx, action) => this.onProofDone(ctx, action)),
      },
      {
        action: COURIER_ACTIONS.proofStop,
        handle: privateOnly((ctx) => this.onProofStop(ctx)),
      },
    ];
  }

  private button(
    ctx: BotContext,
    actorUserId: string,
    text: string,
    action: string,
    orderId: string,
    payload: Record<string, unknown>,
    oneShot = false,
  ): Promise<InlineKeyboardButton> {
    return this.actions
      .create({
        chatId: ctx.chatId,
        action,
        actorUserId,
        orderId,
        payload,
        oneShot,
      })
      .then((callback_data) => ({ text, callback_data }));
  }

  /** Karta tugmasi → sabab (bekor / yetkazib bo'lmadi) yoki darhol tasdiq. */
  /** (BOT-3d) /ishim ro'yxatidagi buyurtma — kartasi (kuryerning o'z JWT'si). */
  private async onOpen(ctx: BotContext, action: TelegramBotAction) {
    const actor = await ctx.actor();
    if (!actor || !action.order_id) return;
    const order = await this.courier
      .getOrder(ctx.fromId!, String(action.order_id))
      .catch((error: unknown) => {
        rethrowPasswordChange(error);
        return null;
      });
    if (!order) {
      await ctx.reply(
        "⚠️ Bu buyurtma ro'yxatingizda yo'q yoki ma'lumot olinmadi — /ishim ni qayta yuboring.",
      );
      return;
    }
    await this.courier.sendCard(ctx, order, actor.user_id);
  }

  private async onOp(ctx: BotContext, action: TelegramBotAction) {
    const op = action.payload.op;
    const orderId = str(action.order_id);
    const actor = await ctx.actor();
    if (!isOp(op) || !orderId || !actor) return;
    if (op === 'cancel' || op === 'cnd') {
      const reasons = op === 'cancel' ? CANCEL_REASONS : CND_REASONS;
      const rows: InlineKeyboardButton[][] = [];
      for (const reason of reasons) {
        rows.push([
          await this.button(
            ctx,
            actor.user_id,
            reason.label,
            COURIER_ACTIONS.reason,
            orderId,
            {
              op,
              reason: reason.code,
            },
          ),
        ]);
      }
      rows.push([
        await this.button(
          ctx,
          actor.user_id,
          '⬅️ Orqaga',
          COURIER_ACTIONS.back,
          orderId,
          {},
        ),
      ]);
      await ctx.reply(`#${orderId} — ${OP_LABEL[op]}. Sababni tanlang:`, {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }
    await this.askConfirm(ctx, actor.user_id, op, orderId, null);
  }

  private async onReason(ctx: BotContext, action: TelegramBotAction) {
    const op = action.payload.op;
    const reason = str(action.payload.reason);
    const orderId = str(action.order_id);
    const actor = await ctx.actor();
    if (!isOp(op) || !orderId || !actor) return;
    const valid =
      op === 'cancel'
        ? cancelReasonValid(reason)
        : Boolean(cndReasonText(reason));
    if (!valid) return;
    await this.askConfirm(ctx, actor.user_id, op, orderId, reason);
  }

  /** (MO2MLPGo #2) Tasodifiy bosishdan himoya: "Tasdiqlaysizmi?". */
  private async askConfirm(
    ctx: BotContext,
    actorUserId: string,
    op: CourierOp,
    orderId: string,
    reason: string | null,
  ) {
    await ctx.reply(`Buyurtma #${orderId} — ${OP_LABEL[op]}. Tasdiqlaysizmi?`, {
      reply_markup: {
        inline_keyboard: [
          [
            await this.button(
              ctx,
              actorUserId,
              '✅ Ha',
              COURIER_ACTIONS.confirm,
              orderId,
              { op, reason },
              true,
            ),
            await this.button(
              ctx,
              actorUserId,
              '⬅️ Orqaga',
              COURIER_ACTIONS.back,
              orderId,
              {},
            ),
          ],
        ],
      },
    });
  }

  /** ✅ Ha (bir martalik): isbot kerak bo'lsa — avval isbot, aks holda amal. */
  private async onConfirm(ctx: BotContext, action: TelegramBotAction) {
    const op = action.payload.op;
    const orderId = str(action.order_id);
    const reason = str(action.payload.reason) || null;
    if (!isOp(op) || !orderId || !ctx.fromId) return;
    if (op === 'sell' || op === 'cancel') {
      const order = await this.courier
        .getOrder(ctx.fromId, orderId)
        .catch((error: unknown) => {
          rethrowPasswordChange(error);
          return null;
        });
      if (order && proofRequired(order, op)) {
        await this.startProof(ctx, { op, order_id: orderId, reason, keys: [] });
        return;
      }
    }
    await this.execute(
      ctx,
      { op, order_id: orderId, reason, keys: [] },
      action.action_id,
      action.action_id,
    );
  }

  private async startProof(
    ctx: BotContext,
    proof: ProofState,
    text: string = PROOF_PROMPT_TEXT,
  ) {
    const actor = await ctx.actor();
    if (!actor) return;
    await this.sessions.update(ctx.chatId, ctx.slug, (s) => ({
      state: { ...s.state, proof },
    }));
    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [
          [
            await this.button(
              ctx,
              actor.user_id,
              '✅ Tugatdim',
              COURIER_ACTIONS.proofDone,
              proof.order_id,
              {},
              true,
            ),
            await this.button(
              ctx,
              actor.user_id,
              '✖️ Bekor',
              COURIER_ACTIONS.proofStop,
              proof.order_id,
              {},
            ),
          ],
        ],
      },
    });
  }

  private async onProofDone(ctx: BotContext, action: TelegramBotAction) {
    const session = await this.sessions.load(ctx.chatId, ctx.slug);
    const proof = session.state.proof as ProofState | undefined;
    if (!proof) {
      await ctx.reply('Isbot kutilayotgan amal yo‘q.');
      return;
    }
    if (!proof.keys.length) {
      // Tugatdim bir martalik edi — yangi tugmalar bilan qayta so'raladi.
      await this.startProof(
        ctx,
        proof,
        "Hech bo'lmasa bitta rasm yoki video yuboring, keyin «✅ Tugatdim».",
      );
      return;
    }
    // (BOT-3d) Kalit — shu «✅ Tugatdim» tugmasi (har isbot urinishiga
    // yangi; release / qayta urinishda o'zgarmaydi). Avvalgi
    // `proof:<order>:<n>` har urinishda bir xil edi: sell → ortga → sell
    // keshdagi eski javobni qaytarardi. Isbot holati YAKUNIY natijadan keyin
    // tozalanadi (execute ichida) — natija noma'lum / handler xatosida
    // qayta ochilgan «✅ Tugatdim» o'sha isbot bilan qayta ishlaydi.
    await this.execute(
      ctx,
      proof,
      `proof:${action.action_id}`,
      action.action_id,
      true,
    );
  }

  private async onProofStop(ctx: BotContext) {
    await this.clearProof(ctx);
    await ctx.reply('⬅️ Isbot bekor qilindi — amal bajarilmadi.');
  }

  private async clearProof(ctx: BotContext) {
    await this.sessions.update(ctx.chatId, ctx.slug, (s) => {
      const state = { ...s.state };
      delete state.proof;
      return { state };
    });
  }

  private async execute(
    ctx: BotContext,
    proof: ProofState,
    idempotencyKey: string,
    /**
     * (BOT-3d) Natija noma'lum bo'lsa qayta ochiladigan «✅ Ha» tugmasi — qayta
     * bosish AYNI kalit bilan ketadi, backend amalni ikkinchi marta bajarmaydi.
     */
    retryActionId?: string,
    /** (BOT-3d) Isbot oqimidan — yakuniy natijadan keyin isbot holati tozalanadi. */
    fromProof = false,
  ) {
    const actor = await ctx.actor();
    if (!ctx.fromId || !actor) return;
    const reason =
      proof.op === 'cnd'
        ? cndReasonText(String(proof.reason ?? ''))
        : (proof.reason ?? undefined);
    const outcome = await this.courier.perform(
      ctx.fromId,
      proof.op,
      proof.order_id,
      {
        reason: reason ?? undefined,
        proofFileKeys: proof.keys,
        idempotencyKey,
      },
    );
    if (
      outcome.kind === 'proof' &&
      (proof.op === 'sell' || proof.op === 'cancel')
    ) {
      await this.showOutcome(ctx, outcome.message);
      await this.startProof(ctx, { ...proof, keys: [] });
      return;
    }
    if (outcome.message === COURIER_OP_UNKNOWN_TEXT && retryActionId) {
      await this.actions.release(retryActionId).catch(() => undefined);
      await this.showOutcome(ctx, COURIER_OP_UNKNOWN_RETRY_TEXT, true);
      return;
    }
    if (fromProof) await this.clearProof(ctx);
    await this.showOutcome(ctx, outcome.message);
    if (outcome.kind === 'ok') {
      await this.courier.refreshCard(
        ctx,
        ctx.fromId,
        proof.order_id,
        actor.user_id,
      );
    } else if (outcome.kind === 'pending') {
      // (MO2MLPGo #7) kartada ⏳ holat — tugmalarsiz, qaror kutiladi.
      await this.courier.refreshCard(
        ctx,
        ctx.fromId,
        proof.order_id,
        actor.user_id,
        "⏳ Market tasdig'i kutilmoqda",
      );
    }
  }

  /**
   * (BOT-3d) Natija tasdiq xabarining O'ZIGA yoziladi (tugmalar olinadi —
   * qayta bosilmaydi); `keepButtons` — «✅ Ha» qayta bosish uchun qoladi.
   * Tahrirlab bo'lmasa — yangi xabar.
   */
  private async showOutcome(
    ctx: BotContext,
    text: string,
    keepButtons = false,
  ): Promise<void> {
    const message = ctx.update.callback_query?.message;
    if (message?.message_id && this.transport) {
      const edited = await this.transport.editMessage(
        ctx.chatId,
        message.message_id,
        {
          text,
          reply_markup:
            keepButtons && message.reply_markup
              ? message.reply_markup
              : { inline_keyboard: [] },
        },
      );
      if (edited) return;
    }
    await ctx.reply(text);
  }
}
