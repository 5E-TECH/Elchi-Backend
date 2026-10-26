import { Injectable } from '@nestjs/common';
import { AI_IMAGE_MAX_BYTES, AI_TEXT_MAX_CHARS, Roles } from '@app/common';
import type { TelegramBotAction } from '../../entities/telegram-bot-action.entity';
import { pickPhotoSize } from '../bot-media';
import type {
  BotActionHandler,
  BotContext,
  BotMessageHandler,
} from '../handlers/bot-context';
import {
  AI_EXPIRED_TEXT,
  AI_ORDER_ACTIONS,
  AiOrderService,
} from './ai-order.service';

/** AI orqali buyurtma — market va market operatori (shaxsiy chatda). */
export const AI_ORDER_ROLES: readonly string[] = [
  Roles.MARKET,
  Roles.MARKET_OPERATOR,
];
/** WHMAIqyo: gateway ai-parse bilan bir xil turlar (JPEG/PNG/WebP). */
const AI_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

export const AI_MEDIA_TEXT =
  '📷 Rasmni SURAT sifatida yuboring — JPG/PNG/WebP, 1,5MB gacha. HEIC, katta fayl va boshqa formatlar qabul qilinmaydi (AI chaqirilmadi).';
export const AI_HINT_TEXT =
  '📝 Buyurtma yaratish: mijoz ismi, telefoni, manzili, mahsulot va narxini BITTA xabarda yuboring yoki rasm tashlang. Buyruqlar: /status <id>, /balans, /help.';
export const AI_TEXT_TOO_LONG_TEXT = `✂️ Matn juda uzun (${AI_TEXT_MAX_CHARS} belgigacha) — qismlarga bo‘lib yuboring.`;

/** Buyurtma matni emas (salomlashish va h.k.) — telefon raqami kabi 7+ raqam yo'q. */
const looksLikeOrder = (text: string) => (text.match(/\d/g) ?? []).length >= 7;

/**
 * (e7KhaeOO) Market / operator shaxsiy chatda buyruq emas MATN yoki RASM
 * tashlaydi → AI preview. Buyruq reyestri yalang'och qoladi (BeePost
 * qarori). Bog'lanmagan chat va boshqa rollar — bu handlerga tushmaydi
 * (fail-closed). Ketma-ketlik — ChatSequencer (chat bo'yicha, DB qulfi,
 * ko'pi bilan 12 ta navbat): draftlar ustma-ust yozilmaydi.
 */
@Injectable()
export class AiOrderHandler implements BotMessageHandler {
  constructor(private readonly ai: AiOrderService) {}

  private async marketActor(ctx: BotContext) {
    if (!ctx.isPrivate) return null;
    const actor = await ctx.actor();
    return actor && AI_ORDER_ROLES.includes(actor.role) ? actor : null;
  }

  async handle(ctx: BotContext): Promise<boolean> {
    const text = ctx.text;
    if (!text || text.startsWith('/')) return false;
    const actor = await this.marketActor(ctx);
    if (!actor) return false;
    if (text.length > AI_TEXT_MAX_CHARS) {
      await ctx.reply(AI_TEXT_TOO_LONG_TEXT);
      return true;
    }
    if (!looksLikeOrder(text)) {
      await ctx.reply(AI_HINT_TEXT);
      return true;
    }
    await this.ai.start(ctx, actor.user_id, { text });
    return true;
  }

  /**
   * Rasm: limit (AI_IMAGE_MAX_BYTES = 1,5MB) ostidagi eng katta o'lcham;
   * hujjat — faqat JPG/PNG/WebP ≤1,5MB. Bitta xabarda bitta rasm (albom
   * yig'ilmaydi) — gateway chegarasi (20) bot uchun ham amal qiladi.
   * HEIC / katta / boshqa format → yo'naltiruvchi matn, AI CHAQIRILMAYDI.
   */
  async handleMedia(ctx: BotContext): Promise<boolean> {
    const message = ctx.update.message;
    if (!message?.photo?.length && !message?.document) return false;
    const actor = await this.marketActor(ctx);
    if (!actor) return false;
    const caption = (message.caption ?? '').trim().slice(0, AI_TEXT_MAX_CHARS);
    if (message.photo?.length) {
      const size = pickPhotoSize(message.photo, AI_IMAGE_MAX_BYTES);
      if (!size) {
        await ctx.reply(AI_MEDIA_TEXT);
        return true;
      }
      await this.ai.start(ctx, actor.user_id, {
        ...(caption ? { text: caption } : {}),
        files: [{ file_id: size.file_id, mime: 'image/jpeg' }],
      });
      return true;
    }
    const document = message.document!;
    const mime = String(document.mime_type ?? '').toLowerCase();
    if (
      !AI_IMAGE_MIME.includes(mime) ||
      (document.file_size ?? 0) > AI_IMAGE_MAX_BYTES
    ) {
      await ctx.reply(AI_MEDIA_TEXT);
      return true;
    }
    await this.ai.start(ctx, actor.user_id, {
      ...(caption ? { text: caption } : {}),
      files: [{ file_id: document.file_id, mime }],
    });
    return true;
  }
}

/** Preview tugmalari: ✅ Yaratish / ✏️ Tuzatish / ❌ Bekor / 🔁 Qayta urinish. */
@Injectable()
export class AiOrderActions {
  readonly handlers: BotActionHandler[];

  constructor(private readonly ai: AiOrderService) {
    const draftOf = (action: TelegramBotAction) => {
      const id = action.payload?.draft_id;
      return typeof id === 'string' ? id : '';
    };
    const privateOnly =
      (fn: (ctx: BotContext, draftId: string) => Promise<void>) =>
      async (ctx: BotContext, action: TelegramBotAction) => {
        if (!ctx.isPrivate) return;
        await fn(ctx, draftOf(action));
      };
    this.handlers = [
      {
        action: AI_ORDER_ACTIONS.confirm,
        expiredText: AI_EXPIRED_TEXT,
        handle: privateOnly((ctx, id) => this.ai.confirm(ctx, id)),
      },
      {
        action: AI_ORDER_ACTIONS.fix,
        expiredText: AI_EXPIRED_TEXT,
        handle: privateOnly((ctx, id) => this.ai.close(ctx, id, 'fix')),
      },
      {
        action: AI_ORDER_ACTIONS.cancel,
        expiredText: AI_EXPIRED_TEXT,
        handle: privateOnly((ctx, id) => this.ai.close(ctx, id, 'cancel')),
      },
      {
        action: AI_ORDER_ACTIONS.retry,
        expiredText: AI_EXPIRED_TEXT,
        handle: privateOnly((ctx, id) => this.ai.retry(ctx, id)),
      },
    ];
  }
}
