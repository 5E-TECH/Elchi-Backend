import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AI_IMAGE_MAX_BYTES, deterministicUuid } from '@app/common';
import {
  TelegramAiDraft,
  TelegramAiDraftInput,
  TelegramAiDraftStatus,
} from '../../entities/telegram-ai-draft.entity';
import { BotActionsService } from '../bot-actions.service';
import { BotGatewayClient } from '../bot-gateway.client';
import { BotTransportService } from '../bot-transport.service';
import type { BotContext } from '../handlers/bot-context';
import type { InlineKeyboardButton } from '../telegram.types';
import {
  AiPreviewOrder,
  aiPreviewText,
  isCreatable,
  toConfirmOrder,
} from './ai-preview';

export const AI_ORDER_ACTIONS = {
  confirm: 'ai.ok',
  fix: 'ai.fix',
  cancel: 'ai.no',
  retry: 'ai.retry',
} as const;

export const AI_WORKING_TEXT = '⏳ AI buyurtmani o‘qiyapti… (1 daqiqagacha)';
export const AI_EXPIRED_TEXT =
  '⏳ Bu ro‘yxat eskirgan — matnni qayta yuboring.';
export const AI_EMPTY_TEXT =
  '🤷 Matndan buyurtma topilmadi — mijoz ismi, telefoni, manzili, mahsulot va narxini yozib yuboring.';
export const AI_NETWORK_TEXT =
  '❌ AI bilan aloqa bo‘lmadi. Matningiz saqlangan — «🔁 Qayta urinish» ni bosing.';
export const AI_CANCELLED_TEXT = '❌ Bekor qilindi — hech narsa yaratilmadi.';
export const AI_FIX_TEXT =
  '✏️ Matnni tuzatib qayta yuboring yoki buyurtmani kabinetda (to‘liq forma) yarating.';
export const AI_CREATING_TEXT = '⏳ Buyurtmalar yaratilmoqda…';
export const AI_ALREADY_CREATED_TEXT = 'ℹ️ Bu ro‘yxat allaqachon yaratilgan.';
export const AI_CONFIRM_FAILED_TEXT =
  '❌ Javob olinmadi — «✅ Yaratish» ni qayta bosing (takroriy buyurtma yaratilmaydi).';

const PARSE_TIMEOUT_MS = 95_000;
const CONFIRM_TIMEOUT_MS = 90_000;
/** Server sababi: qayta urinish ma'noli (aks holda — kabinet). */
const RETRYABLE_REASONS = new Set(['network', 'ai_error']);

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const rowsOf = <T>(result: unknown): T[] => {
  if (!Array.isArray(result)) return [];
  return (Array.isArray(result[0]) ? result[0] : result) as T[];
};

/** EL-<id+100000> — mijozga ko'rinadigan raqam (order-service bilan bir xil). */
const orderNumber = (id: unknown) => {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? `EL-${numeric + 100000}`
    : `#${str(id)}`;
};

interface ParseData {
  ok?: boolean;
  orders?: AiPreviewOrder[];
  draft_id?: string;
  reason?: string;
  message?: string;
}

interface ConfirmResult {
  index: number;
  ok: boolean;
  order_id?: string;
  reason?: string;
  idempotent_replay?: boolean;
}

/**
 * (e7KhaeOO) Bot — AI buyurtma oqimining faqat CHAQIRUVCHISI (transport + UX):
 * ekstraksiya botda YOZILMAYDI. Mavjud endpointlar operatorning O'Z JWT'si
 * bilan: `POST /orders/ai-parse` (preview, hech narsa yaratmaydi) va
 * `POST /orders/ai-confirm` (yaratish: server qayta tekshiradi, market_id
 * operatorning `user.market_id` sidan, dublikat — `ai:<market>:<draft>:<index>`).
 *
 * Qoralama DB'da (`telegram_ai_drafts`) — restartdan keyin tugma ishlaydi.
 * "✅ Yaratish" ikki marta bosilsa: `preview → creating` shartli UPDATE —
 * faqat bittasi o'tadi (server dedupe — ikkinchi qatlam). Xato xabarlari
 * serverniki (`message`), bot o'zi AI matni yasamaydi.
 */
@Injectable()
export class AiOrderService {
  private readonly logger = new Logger(AiOrderService.name);

  constructor(
    @InjectRepository(TelegramAiDraft)
    private readonly drafts: Repository<TelegramAiDraft>,
    private readonly gateway: BotGatewayClient,
    private readonly actions: BotActionsService,
    private readonly transport: BotTransportService,
    private readonly config: ConfigService,
  ) {}

  get cabinetUrl(): string {
    return (
      this.config.get<string>('ELCHI_CABINET_URL') ??
      'https://admin.elchipochta.uz'
    ).replace(/\/+$/, '');
  }

  cabinetCreateButton(): InlineKeyboardButton {
    return {
      text: '🌐 Kabinetda yaratish',
      url: `${this.cabinetUrl}/orders/create`,
    };
  }

  /** Yangi qoralama: "⏳" xabari → ai-parse → preview (yoki xato). */
  async start(
    ctx: BotContext,
    actorUserId: string,
    input: TelegramAiDraftInput,
  ): Promise<void> {
    const draft: Partial<TelegramAiDraft> = {
      id: randomUUID(),
      chat_id: ctx.chatId,
      actor_user_id: actorUserId,
      status: 'parsing',
      input,
    };
    await this.drafts.insert(draft as never);
    const working = await ctx.reply(AI_WORKING_TEXT);
    const messageId = working.result?.message_id;
    if (messageId) {
      draft.message_id = String(messageId);
      await this.drafts.update(
        { id: draft.id },
        { message_id: String(messageId) },
      );
    }
    await this.runParse(ctx, draft as TelegramAiDraft);
  }

  /** `🔁 Qayta urinish` — saqlangan kirish bilan (failed → parsing). */
  async retry(ctx: BotContext, draftId: string): Promise<void> {
    const draft = await this.claim(draftId, ['failed'], 'parsing');
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    await this.show(ctx, draft, AI_WORKING_TEXT, []);
    await this.runParse(ctx, draft);
  }

  async runParse(ctx: BotContext, draft: TelegramAiDraft): Promise<void> {
    const telegramId = ctx.fromId ?? ctx.chatId;
    const form = new FormData();
    const text = str(draft.input?.text).trim();
    if (text) form.append('text', text);
    try {
      for (const file of draft.input?.files ?? []) {
        const downloaded = await this.transport.downloadFile(
          file.file_id,
          AI_IMAGE_MAX_BYTES,
        );
        // WHMAIqyo: WebP ham (gateway ruxsat ro'yxati bilan bir xil).
        const mime =
          file.mime === 'image/png' || /\.png$/i.test(downloaded.file_path)
            ? 'image/png'
            : file.mime === 'image/webp' ||
                /\.webp$/i.test(downloaded.file_path)
              ? 'image/webp'
              : 'image/jpeg';
        const ext =
          mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        form.append(
          'images',
          new Blob([new Uint8Array(downloaded.buffer)], { type: mime }),
          `image.${ext}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `ai draft ${draft.id}: rasm yuklanmadi — ${this.transport.describe(error)}`,
      );
      await this.fail(
        ctx,
        draft,
        "❌ Rasmni yuklab bo'lmadi — qayta urinib ko'ring.",
        true,
      );
      return;
    }

    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request(
        telegramId,
        'POST',
        '/orders/ai-parse',
        form,
        {
          timeoutMs: PARSE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      this.logger.warn(
        `ai draft ${draft.id}: ai-parse — ${error instanceof Error ? error.message : 'error'}`,
      );
      await this.fail(ctx, draft, AI_NETWORK_TEXT, true);
      return;
    }
    const body = res.body as { data?: ParseData; message?: unknown } | null;
    if (res.status >= 400) {
      const message = str(body?.message);
      await this.fail(
        ctx,
        draft,
        res.status === 429
          ? '⏳ Juda ko‘p so‘rov — birozdan so‘ng «🔁 Qayta urinish» ni bosing.'
          : `❌ ${message || 'So‘rov qabul qilinmadi'}`,
        res.status === 429 || res.status >= 500,
      );
      return;
    }
    const data = body?.data ?? {};
    if (data.ok !== true) {
      const reason = str(data.reason);
      await this.fail(
        ctx,
        draft,
        `❌ ${str(data.message) || 'AI javob bermadi'}`,
        RETRYABLE_REASONS.has(reason),
      );
      return;
    }
    const orders = Array.isArray(data.orders) ? data.orders : [];
    if (!orders.length) {
      await this.setStatus(draft.id, 'empty');
      await this.show(ctx, draft, AI_EMPTY_TEXT, []);
      return;
    }
    await this.drafts.update(
      { id: draft.id },
      {
        status: 'preview',
        orders: orders as never,
        ai_draft_id: str(data.draft_id) || null,
        error: null,
        updated_at: new Date(),
      },
    );
    const rows: InlineKeyboardButton[][] = [];
    const creatable = orders.filter(isCreatable).length;
    if (creatable) {
      rows.push([
        await this.button(ctx, draft, '✅ Yaratish', AI_ORDER_ACTIONS.confirm),
      ]);
    }
    rows.push([
      await this.button(ctx, draft, '✏️ Tuzatish', AI_ORDER_ACTIONS.fix),
      await this.button(ctx, draft, '❌ Bekor', AI_ORDER_ACTIONS.cancel),
    ]);
    await this.show(ctx, draft, aiPreviewText(orders), rows, 'HTML');
  }

  /** `✅ Yaratish`: preview → creating (faqat bitta bosish o'tadi). */
  async confirm(ctx: BotContext, draftId: string): Promise<void> {
    const draft = await this.claim(draftId, ['preview'], 'creating');
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    const ready = previews.filter(isCreatable);
    const telegramId = ctx.fromId ?? ctx.chatId;
    let res: { status: number; body: unknown };
    try {
      await this.show(ctx, draft, AI_CREATING_TEXT, []);
      res = await this.gateway.request(
        telegramId,
        'POST',
        '/orders/ai-confirm',
        {
          request_id: deterministicUuid(`telegram-ai:${draft.id}`),
          orders: ready.map((order) =>
            toConfirmOrder(order, draft.ai_draft_id),
          ),
        },
        { timeoutMs: CONFIRM_TIMEOUT_MS },
      );
    } catch (error) {
      this.logger.warn(
        `ai draft ${draft.id}: ai-confirm — ${error instanceof Error ? error.message : 'error'}`,
      );
      await this.backToPreview(ctx, draft, AI_CONFIRM_FAILED_TEXT);
      return;
    }
    const body = res.body as {
      data?: { results?: ConfirmResult[] };
      message?: unknown;
    } | null;
    if (res.status >= 400 || !Array.isArray(body?.data?.results)) {
      await this.backToPreview(
        ctx,
        draft,
        res.status >= 500 || res.status < 400
          ? AI_CONFIRM_FAILED_TEXT
          : `❌ ${str(body?.message) || 'So‘rov qabul qilinmadi'}`,
      );
      return;
    }
    const results = body.data.results;
    await this.drafts.update(
      { id: draft.id },
      { status: 'created', results: results as never, updated_at: new Date() },
    );
    const lines = results.map((result) => {
      const order = ready[result.index];
      const n = (order?.index ?? result.index) + 1;
      return result.ok
        ? `✅ ${n}) Buyurtma ${orderNumber(result.order_id)} ${result.idempotent_replay ? 'avval yaratilgan' : 'yaratildi'}`
        : `❌ ${n}) ${str(result.reason) || 'yaratilmadi'}`;
    });
    const skipped = previews.length - ready.length;
    if (skipped > 0) {
      lines.push(
        `🟠 ${skipped} ta buyurtma kamchilik bilan — kabinetda yarating.`,
      );
    }
    await this.show(
      ctx,
      draft,
      lines.join('\n'),
      skipped > 0 ? [[this.cabinetCreateButton()]] : [],
    );
  }

  /** `✏️ Tuzatish` / `❌ Bekor` — preview yopiladi, hech narsa yaratilmaydi. */
  async close(ctx: BotContext, draftId: string, kind: 'fix' | 'cancel') {
    const draft = await this.claim(
      draftId,
      ['preview', 'failed', 'empty'],
      'cancelled',
    );
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    await this.show(
      ctx,
      draft,
      kind === 'fix' ? AI_FIX_TEXT : AI_CANCELLED_TEXT,
      kind === 'fix' ? [[this.cabinetCreateButton()]] : [],
    );
  }

  private async backToPreview(
    ctx: BotContext,
    draft: TelegramAiDraft,
    text: string,
  ) {
    await this.setStatus(draft.id, 'preview');
    const rows: InlineKeyboardButton[][] = [
      [await this.button(ctx, draft, '✅ Yaratish', AI_ORDER_ACTIONS.confirm)],
      [
        await this.button(ctx, draft, '✏️ Tuzatish', AI_ORDER_ACTIONS.fix),
        await this.button(ctx, draft, '❌ Bekor', AI_ORDER_ACTIONS.cancel),
      ],
    ];
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    await this.show(
      ctx,
      draft,
      `${aiPreviewText(previews)}\n\n${text}`,
      rows,
      'HTML',
    );
  }

  private async fail(
    ctx: BotContext,
    draft: TelegramAiDraft,
    text: string,
    retryable: boolean,
  ) {
    await this.drafts.update(
      { id: draft.id },
      { status: 'failed', error: text.slice(0, 300), updated_at: new Date() },
    );
    const rows: InlineKeyboardButton[][] = retryable
      ? [
          [
            await this.button(
              ctx,
              draft,
              '🔁 Qayta urinish',
              AI_ORDER_ACTIONS.retry,
            ),
            await this.button(ctx, draft, '❌ Bekor', AI_ORDER_ACTIONS.cancel),
          ],
        ]
      : [[this.cabinetCreateButton()]];
    await this.show(ctx, draft, text, rows);
  }

  /** Da'vo o'tmadi — nima uchun: eskirgan / yaratilmoqda / yaratilgan / bekor. */
  private async explainState(ctx: BotContext, draftId: string) {
    const draft = await this.drafts.findOne({ where: { id: draftId } });
    if (!draft || new Date(draft.expires_at).getTime() <= Date.now()) {
      await ctx.reply(AI_EXPIRED_TEXT);
      return;
    }
    const text: Partial<Record<TelegramAiDraftStatus, string>> = {
      creating: AI_CREATING_TEXT,
      parsing: AI_WORKING_TEXT,
      created: AI_ALREADY_CREATED_TEXT,
      cancelled: AI_CANCELLED_TEXT,
    };
    await ctx.reply(text[draft.status] ?? AI_EXPIRED_TEXT);
  }

  private async claim(
    draftId: string,
    from: TelegramAiDraftStatus[],
    to: TelegramAiDraftStatus,
  ): Promise<TelegramAiDraft | null> {
    if (!/^[0-9a-f-]{36}$/i.test(draftId)) return null;
    const rows = rowsOf<TelegramAiDraft>(
      await this.drafts.query(
        `UPDATE "notification_schema"."telegram_ai_drafts"
            SET "status" = $3, "updated_at" = now()
          WHERE "id" = $1 AND "status" = ANY($2::varchar[]) AND "expires_at" > now()
        RETURNING *`,
        [draftId, from, to],
      ),
    );
    return rows[0] ?? null;
  }

  private async setStatus(id: string, status: TelegramAiDraftStatus) {
    await this.drafts.update({ id }, { status, updated_at: new Date() });
  }

  private async button(
    ctx: BotContext,
    draft: TelegramAiDraft,
    text: string,
    action: string,
  ): Promise<InlineKeyboardButton> {
    return {
      text,
      callback_data: await this.actions.create({
        chatId: ctx.chatId,
        action,
        actorUserId: String(draft.actor_user_id),
        payload: { draft_id: draft.id },
        oneShot: false,
      }),
    };
  }

  /** Qoralama xabarini tahrirlaydi (bo'lmasa — yangi xabar), tugmalarni bog'laydi. */
  private async show(
    ctx: BotContext,
    draft: TelegramAiDraft,
    text: string,
    rows: InlineKeyboardButton[][],
    parseMode?: 'HTML',
  ): Promise<void> {
    const markup = { inline_keyboard: rows };
    let messageId = draft.message_id ? String(draft.message_id) : '';
    const edited = messageId
      ? await this.transport
          .editMessage(ctx.chatId, messageId, {
            text,
            reply_markup: markup,
            ...(parseMode ? { parse_mode: parseMode } : {}),
          })
          .catch(() => false)
      : false;
    if (!edited) {
      const sent = await ctx.reply(text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(rows.length ? { reply_markup: markup } : {}),
      });
      messageId = sent.result?.message_id ? String(sent.result.message_id) : '';
      if (messageId) {
        draft.message_id = messageId;
        await this.drafts.update({ id: draft.id }, { message_id: messageId });
      }
    }
    const callbacks = rows
      .flat()
      .map((button) => button.callback_data)
      .filter((data): data is string => Boolean(data));
    if (callbacks.length && messageId) {
      await this.actions.attachMessage(callbacks, messageId);
    }
  }
}
