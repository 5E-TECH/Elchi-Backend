import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ActivityLogService } from '@app/common';
import { BotActionsService } from './bot-actions.service';
import { BotActorService, type BotActor } from './bot-actor.service';
import { resolveBotConfig } from './bot-config';
import { checkIncomingMedia } from './bot-media';
import { botUpdatesTotal } from './bot-metrics';
import { BotOutboxService } from './bot-outbox.service';
import { BotRateLimiterService } from './bot-rate-limiter.service';
import { BotSessionService, type BotSession } from './bot-session.service';
import { BotTransportService } from './bot-transport.service';
import { ChatSequencer } from './chat-sequencer';
import {
  BOT_ACTION_HANDLERS,
  type BotActionHandler,
  type BotContext,
  type BotMessageHandler,
} from './handlers/bot-context';
import { CommandGateHandler } from './handlers/command-gate.handler';
import { AiOrderHandler } from './ai-order/ai-order.handler';
import { CourierHandler } from './courier/courier.handler';
import { GroupHandler } from './handlers/group.handler';
import { MarketHandler, UNKNOWN_COMMAND_TEXT } from './handlers/market.handler';
import { MembershipHandler } from './handlers/membership.handler';
import { StartHandler } from './handlers/start.handler';
import type { TelegramUpdate } from './telegram.types';

/**
 * Tugma qatori yo'q: odatda muddati o'tib tozalangan (prune, >48 soat) eski
 * karta — Cp2v3ZJ7 TC12: "eskirgan" deb ANIQ aytiladi.
 */
export const ACTION_UNKNOWN_TEXT =
  '⌛ Bu tugma eskirgan — endi ishlamaydi. Menyuni qayta oching: /start';
export const ACTION_EXPIRED_TEXT =
  "⌛ Bu ro'yxat eskirgan — menyuni qayta oching: /start";
export const ACTION_CONSUMED_TEXT = '✔️ Bu amal allaqachon bajarilgan.';
export const ACTION_FOREIGN_TEXT = '🔒 Bu tugma siz uchun emas.';
export const CHAT_QUEUE_FULL_TEXT =
  '⏳ Juda ko‘p xabar navbatda — oldingilari tugashini kuting.';

const chatIdIsPrivate = (update: TelegramUpdate) =>
  (update.message?.chat?.type ?? update.callback_query?.message?.chat?.type) ===
  'private';

/** Shutdown'da navbatdagi ishlar shuncha kutiladi (docker stop 10 s dan kam). */
const DRAIN_TIMEOUT_MS = 8_000;

/**
 * (ZlpXb4Wh #4) Yagona kirish: update → handler. Ikkala transport (webhook
 * RMQ hodisasi va polling zaxirasi) shu yerga keladi:
 *  1. `botSlug` noto'g'ri → jim tashlanadi (log + 0 chiquvchi chaqiruv);
 *  2. `my_chat_member` → kanal holati;
 *  3. kiruvchi cheklov — chat bo'yicha 20/daqiqa, oshgani JIM tashlanadi;
 *  4. chat bo'yicha ketma-ket navbat (replikalararo qulf bilan);
 *  5. callback → `a:<id>` (holat DB'dan) / matn → handlerlar zanjiri.
 * Ishlov xatosi bir marta qayta urinadi, ikkinchisida tashlanadi (poison
 * update cheksiz aylanmaydi).
 */
@Injectable()
export class BotRouterService implements OnModuleDestroy {
  private readonly logger = new Logger(BotRouterService.name);
  readonly slug: string;
  private readonly sequencer: ChatSequencer;
  private readonly messageHandlers: BotMessageHandler[];
  private readonly actionHandlers = new Map<string, BotActionHandler>();

  constructor(
    config: ConfigService,
    private readonly limiter: BotRateLimiterService,
    private readonly sessions: BotSessionService,
    private readonly actions: BotActionsService,
    private readonly actors: BotActorService,
    private readonly outbox: BotOutboxService,
    private readonly transport: BotTransportService,
    private readonly activityLog: ActivityLogService,
    private readonly membership: MembershipHandler,
    start: StartHandler,
    private readonly group: GroupHandler,
    market: MarketHandler,
    gate: CommandGateHandler,
    private readonly courier: CourierHandler,
    @Optional() dataSource?: DataSource,
    @Optional()
    @Inject(BOT_ACTION_HANDLERS)
    actionHandlers?: BotActionHandler[],
    // (e7KhaeOO) market/operator matni yoki rasmi → AI preview. Ixtiyoriy:
    // eski spec'lar routerni usiz quradi.
    @Optional() private readonly aiOrder?: AiOrderHandler,
  ) {
    this.slug = resolveBotConfig((key) => config.get(key)).slug;
    this.sequencer = new ChatSequencer(dataSource ?? null);
    // Tartib muhim: umumiy (start/link/id) → guruh → rol darvozasi
    // (3ZfiXuaW) → rol buyruqlari.
    this.messageHandlers = [
      start,
      group,
      gate,
      market,
      courier,
      ...(aiOrder ? [aiOrder] : []),
    ];
    for (const handler of actionHandlers ?? []) {
      this.actionHandlers.set(handler.action, handler);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const drained = await this.sequencer.drain(DRAIN_TIMEOUT_MS);
    if (!drained) {
      this.logger.warn(
        `Bot shutdown: ${this.sequencer.size} ta chat navbati ${DRAIN_TIMEOUT_MS} ms ichida tugamadi`,
      );
    }
  }

  /**
   * Kirish nuqtasi. Hech qachon throw qilmaydi. Natija — kuzatuv/test uchun.
   */
  async dispatch(
    slug: string,
    update: TelegramUpdate,
  ): Promise<'ignored' | 'dropped' | 'done' | 'failed'> {
    if (String(slug ?? '').toLowerCase() !== this.slug) {
      botUpdatesTotal.inc({ bot: this.slug, type: 'dropped_slug' });
      this.logger.warn(
        `Telegram update noto'g'ri botSlug bilan keldi — jim tashlandi`,
      );
      return 'ignored';
    }
    if (!update || typeof update !== 'object') return 'ignored';

    if (update.my_chat_member) {
      botUpdatesTotal.inc({ bot: this.slug, type: 'my_chat_member' });
      try {
        await this.membership.handle(this.slug, update.my_chat_member);
        return 'done';
      } catch (error) {
        this.logger.error(`my_chat_member: ${this.transport.describe(error)}`);
        return 'failed';
      }
    }

    const chatId = chatIdOf(update);
    if (!chatId) return 'ignored';
    const type = update.callback_query ? 'callback_query' : 'message';

    const decision = await this.limiter.inbound(chatId);
    if (!decision.allowed) {
      // Javob YUBORILMAYDI — aks holda limitning o'zi amplifikator bo'ladi.
      botUpdatesTotal.inc({ bot: this.slug, type: 'dropped_rate' });
      return 'dropped';
    }
    botUpdatesTotal.inc({ bot: this.slug, type });

    const result = await this.sequencer.run(chatId, () =>
      this.processWithRetry(update, chatId),
    );
    if (result === 'dropped') {
      botUpdatesTotal.inc({ bot: this.slug, type: 'dropped_queue' });
      // (e7KhaeOO / BeePost MAX_QUEUE) shaxsiy chatga bitta tushuntirish —
      // navbatdan tashqari, to'g'ridan-to'g'ri outbox orqali.
      if (chatIdIsPrivate(update)) {
        await this.outbox
          .send({
            chatId,
            text: CHAT_QUEUE_FULL_TEXT,
            source: 'bot.queue_full',
          })
          .catch(() => undefined);
      }
    }
    return result;
  }

  private async processWithRetry(
    update: TelegramUpdate,
    chatId: string,
  ): Promise<void> {
    try {
      await this.process(update, chatId);
      return;
    } catch (error) {
      this.logger.warn(
        `Update ${update.update_id} xato, bir marta qayta urinish: ${this.transport.describe(error)}`,
      );
    }
    try {
      await this.process(update, chatId);
    } catch (error) {
      this.logger.error(
        `Update ${update.update_id} ikki marta xato — tashlandi: ${this.transport.describe(error)}`,
      );
    }
  }

  private async process(update: TelegramUpdate, chatId: string): Promise<void> {
    const ctx = this.buildContext(update, chatId);
    if (update.callback_query) {
      await this.handleCallback(ctx, update);
      return;
    }
    const message = update.message;
    if (!message) return;

    // (GL2GgtEc #4) media: 20MB dan katta / HEIC — aniq yo'naltiruv matni.
    // (z2FRwu2c) isbot rejimida — kuryer isboti sifatida qabul qilinadi.
    if (message.photo || message.document || message.video) {
      if (await this.courier.handleMedia(ctx)) return;
      // (e7KhaeOO) market/operator rasmi → AI (2MB, JPG/PNG/WebP; boshqasi — yo'naltiruv).
      if (this.aiOrder && (await this.aiOrder.handleMedia(ctx))) return;
      const media = checkIncomingMedia(message);
      if (!media.ok && media.reply) await ctx.reply(media.reply);
      return;
    }
    // (ysBqD9Nx) guruhga yangi a'zo — market ogohlantiriladi (servis xabari).
    if (!ctx.isPrivate && message.new_chat_members?.length) {
      await this.group.onNewMembers(ctx, message.new_chat_members);
      return;
    }
    if (!ctx.text) return;

    for (const handler of this.messageHandlers) {
      if (await handler.handle(ctx)) return;
    }
    // (3ZfiXuaW #1) FAIL-CLOSED: bog'lanmagan chatga faqat /start (ulash
    // ko'rsatmasi) javob beradi — tushunarsiz matnga jim.
    if (ctx.isPrivate && (await ctx.actor())) {
      await ctx.reply(UNKNOWN_COMMAND_TEXT, { parse_mode: 'HTML' });
    }
  }

  /**
   * `a:<action_id>`: spinner darhol o'chiriladi (15 s chegarasi), holat
   * DB'dan; aktor `callback_query.from.id` bo'yicha (chat bo'yicha EMAS).
   */
  private async handleCallback(
    ctx: BotContext,
    update: TelegramUpdate,
  ): Promise<void> {
    const callback = update.callback_query!;
    const lookup = await this.actions.lookup(callback.data);
    if (lookup.status !== 'ok') {
      const handler =
        lookup.status === 'unknown'
          ? undefined
          : this.actionHandlers.get(lookup.action.action);
      const text =
        lookup.status === 'consumed'
          ? ACTION_CONSUMED_TEXT
          : lookup.status === 'expired'
            ? (handler?.expiredText ?? ACTION_EXPIRED_TEXT)
            : ACTION_UNKNOWN_TEXT;
      await this.transport.answerCallbackQuery(callback.id, text);
      return;
    }
    const action = lookup.action;
    const handler = this.actionHandlers.get(action.action);
    if (action.actor_user_id) {
      const actor = await ctx.actor();
      if (!actor || actor.user_id !== String(action.actor_user_id)) {
        await this.transport.answerCallbackQuery(
          callback.id,
          handler?.foreignText ?? ACTION_FOREIGN_TEXT,
        );
        return;
      }
    }
    if (!handler) {
      await this.transport.answerCallbackQuery(
        callback.id,
        ACTION_UNKNOWN_TEXT,
      );
      return;
    }
    if (action.one_shot && !(await this.actions.consume(action.action_id))) {
      await this.transport.answerCallbackQuery(
        callback.id,
        ACTION_CONSUMED_TEXT,
      );
      return;
    }
    await this.transport.answerCallbackQuery(callback.id);
    await this.activityLog.log({
      entity_type: action.order_id ? 'Order' : 'TelegramChat',
      entity_id: action.order_id ? String(action.order_id) : ctx.chatId,
      action: 'notification.tg_callback',
      user_id: (await ctx.actor())?.user_id ?? null,
      metadata: {
        chat_id: ctx.chatId,
        action: action.action,
        order_id: action.order_id ? String(action.order_id) : null,
      },
    });
    await handler.handle(ctx, action);
  }

  private buildContext(update: TelegramUpdate, chatId: string): BotContext {
    const message = update.message ?? update.callback_query?.message;
    const from = update.message?.from ?? update.callback_query?.from;
    const chatType = String(message?.chat?.type ?? 'private');
    let actorPromise: Promise<BotActor | null> | null = null;
    let sessionPromise: Promise<BotSession> | null = null;
    const fromId =
      from?.id === undefined || from?.id === null ? null : String(from.id);
    return {
      slug: this.slug,
      update,
      chatId,
      chatType,
      isPrivate: chatType === 'private',
      fromId,
      text: String(update.message?.text ?? '').trim(),
      actor: () => (actorPromise ??= this.actors.resolve(fromId)),
      session: () => (sessionPromise ??= this.sessions.load(chatId, this.slug)),
      reply: (text, extra) =>
        this.outbox.send({
          chatId,
          text,
          parse_mode: extra?.parse_mode,
          reply_markup: extra?.reply_markup,
          source: 'bot.reply',
        }),
    };
  }
}

/** message.chat.id → callback_query.message.chat.id → callback_query.from.id. */
export function chatIdOf(update: TelegramUpdate): string | null {
  const id =
    update.message?.chat?.id ??
    update.callback_query?.message?.chat?.id ??
    update.callback_query?.from?.id;
  return id === undefined || id === null ? null : String(id);
}
