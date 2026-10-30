import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AI_BOT_IMAGE_MAX_BYTES,
  deterministicUuid,
  formatOrderNumber,
} from '@app/common';
import {
  TelegramAiDraft,
  TelegramAiDraftInput,
  TelegramAiDraftStatus,
} from '../../entities/telegram-ai-draft.entity';
import { BotActionsService } from '../bot-actions.service';
import {
  BotGatewayClient,
  BOT_PASSWORD_CHANGE_TEXT,
  BotPasswordChangeRequiredError,
} from '../bot-gateway.client';
import { BotOutboxService } from '../bot-outbox.service';
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
/** (BOT-3b) 2 daqiqadan eski `parsing` — ishchi yiqilgan / qotgan. */
export const AI_STALE_TEXT =
  '⏳ AI javobi kechikdi. Matningiz saqlangan — «🔁 Qayta urinish» ni bosing.';

/**
 * (BOT-3b) Shundan eski (ishchi olgan) `parsing` / `creating` — qotgan,
 * tiklanadi. Eng yomon budjetdan (getFile + 429 kutish + yuklab olish +
 * token + ai-parse 95 s ≈ 3 daqiqa) katta; baribir kech natija da'vo tokeni
 * bilan tashlanadi.
 */
export const AI_STALE_AFTER_MS = 4 * 60_000;
/** Yangi qoralamani zaxira tick shuncha kutadi (start «⏳» message_id ni yozsin). */
const AI_TICK_MIN_AGE_MS = 5_000;
/** (BOT-3b) Bir replikada bir vaqtda ishlanadigan AI qoralamalar. */
export const AI_WORKER_PARALLEL = 5;

const PARSE_TIMEOUT_MS = 95_000;
const CONFIRM_TIMEOUT_MS = 90_000;
/** Server sababi: qayta urinish ma'noli (aks holda — kabinet). */
const RETRYABLE_REASONS = new Set(['network', 'ai_error']);

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const isUniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
};

const rowsOf = <T>(result: unknown): T[] => {
  if (!Array.isArray(result)) return [];
  return (Array.isArray(result[0]) ? result[0] : result) as T[];
};

/** EL-<id+100000> — mijozga ko'rinadigan raqam (order-service bilan bir xil). */
const orderNumber = (id: unknown) => formatOrderNumber(id) ?? `#${str(id)}`;

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
/*
 * (BOT-3b) AI FONDA. Avval ai-parse (95 s gacha) va ai-confirm (90 s gacha)
 * bot update'i ichida — chat qulfi va RMQ xabari ostida — bajarilardi:
 * ack ish oxirida bo'lgani uchun AI to'lqinida kuryer tugmalari ham
 * kutardi, xato bo'lsa router update'ni QAYTA ishlab AI'ni ikki marta
 * chaqirardi. Endi update «⏳» xabari bilan darhol tugaydi; qoralamani
 * fondagi ishchi oladi (`worker_at`), QAYTA URINMAYDI (xato — «🔁 Qayta
 * urinish» tugmasi). Qoralama id'si update'dan deterministik — takror
 * update ikkinchi qoralama ochmaydi. 2 daqiqadan eski `parsing` /
 * `creating` (ishchi yiqilgan) tiklanadi.
 */
@Injectable()
export class AiOrderService implements OnModuleDestroy {
  private readonly logger = new Logger(AiOrderService.name);
  private readonly inflight = new Set<Promise<void>>();
  private ticking = false;
  private stopped = false;

  constructor(
    @InjectRepository(TelegramAiDraft)
    private readonly drafts: Repository<TelegramAiDraft>,
    private readonly gateway: BotGatewayClient,
    private readonly actions: BotActionsService,
    private readonly transport: BotTransportService,
    private readonly config: ConfigService,
    private readonly outbox: BotOutboxService,
  ) {}

  onModuleDestroy() {
    this.stopped = true;
  }

  /** Fondagi ishlar tugashini kutadi (testlar va shutdown uchun). */
  async idle(): Promise<void> {
    while (this.inflight.size) {
      await Promise.allSettled([...this.inflight]);
    }
  }

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

  /**
   * Yangi qoralama: "⏳" xabari, keyin FONDA ai-parse → preview (yoki xato).
   * Id update'dan deterministik: router update'ni qayta ishlasa ham ikkinchi
   * qoralama (va ikkinchi AI chaqiruvi) bo'lmaydi.
   */
  async start(
    ctx: BotContext,
    actorUserId: string,
    input: TelegramAiDraftInput,
  ): Promise<void> {
    const draft: Partial<TelegramAiDraft> = {
      id: deterministicUuid(
        `telegram-ai-draft:${ctx.chatId}:${str(ctx.update?.update_id)}`,
      ),
      chat_id: ctx.chatId,
      actor_user_id: actorUserId,
      status: 'parsing',
      input,
    };
    try {
      await this.drafts.insert(draft as never);
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    const working = await ctx.reply(AI_WORKING_TEXT);
    const messageId = working.result?.message_id;
    if (messageId) {
      draft.message_id = String(messageId);
      await this.drafts.update(
        { id: draft.id },
        { message_id: String(messageId) },
      );
    }
    this.schedule(String(draft.id), 'parsing');
  }

  /** `🔁 Qayta urinish` — saqlangan kirish bilan (failed → parsing), fonda. */
  async retry(ctx: BotContext, draftId: string): Promise<void> {
    const draft = await this.claim(draftId, ['failed'], 'parsing');
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    await this.show(ctx, draft, AI_WORKING_TEXT, []);
    this.schedule(draft.id, 'parsing');
  }

  /** Shu replikada darhol fonda ishlash (interval — zaxira / restartdan keyin). */
  private schedule(draftId: string, status: 'parsing' | 'creating'): void {
    if (this.stopped) return;
    // Replikadagi AI parallelligi chegarasi: band bo'lsa qoralama navbatda
    // qoladi (`worker_at` NULL) — zaxira tick bo'shaganda oladi.
    if (this.inflight.size >= AI_WORKER_PARALLEL) return;
    const job: Promise<void> = this.claimAndWork(draftId, status)
      .catch((error: unknown) =>
        this.logger.error(
          `ai draft ${draftId}: fondagi ish — ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        this.inflight.delete(job);
      });
    this.inflight.add(job);
  }

  private async claimAndWork(
    draftId: string,
    status: 'parsing' | 'creating',
  ): Promise<void> {
    const rows = rowsOf<TelegramAiDraft>(
      await this.drafts.query(
        `UPDATE "notification_schema"."telegram_ai_drafts"
            SET "worker_at" = now(), "worker_token" = gen_random_uuid(),
                "updated_at" = now()
          WHERE "id" = $1 AND "status" = $2 AND "worker_at" IS NULL
            AND "expires_at" > now()
        RETURNING *`,
        [draftId, status],
      ),
    );
    if (rows[0]) await this.work(rows[0]);
  }

  /** Bitta qoralama: parse yoki confirm. QAYTA URINMAYDI — xato tugma bilan. */
  private async work(draft: TelegramAiDraft): Promise<void> {
    const ctx = this.workerContext(draft);
    try {
      if (draft.status === 'creating') await this.runConfirm(ctx, draft);
      else await this.runParse(ctx, draft);
    } catch (error) {
      this.logger.warn(
        `ai draft ${draft.id}: ${draft.status} — ${this.transport.describe(error)}`,
      );
      if (draft.status === 'creating') {
        await this.backToPreview(ctx, draft, AI_CONFIRM_FAILED_TEXT);
      } else {
        await this.fail(ctx, draft, AI_NETWORK_TEXT, true);
      }
    }
  }

  /**
   * Fondagi ishchi uchun kontekst: AI faqat SHAXSIY chatda (handler
   * `isPrivate`), ya'ni chat id = Telegram aktori id'si.
   */
  private workerContext(draft: TelegramAiDraft): BotContext {
    const chatId = String(draft.chat_id);
    return {
      chatId,
      fromId: chatId,
      isPrivate: true,
      reply: (text, extra) =>
        this.outbox.send({
          chatId,
          text,
          parse_mode: extra?.parse_mode,
          reply_markup: extra?.reply_markup,
          source: 'bot.ai_order',
        }),
    } as BotContext;
  }

  /**
   * (BOT-3b) Zaxira: restart / boshqa replika yiqilganidan keyin olinmay
   * qolgan qoralamalar va `AI_STALE_AFTER_MS` dan eski qotganlar.
   */
  @Interval('telegram-ai-worker', 5_000)
  async tick(): Promise<number> {
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;
    try {
      await this.recoverStale();
      const capacity = AI_WORKER_PARALLEL - this.inflight.size;
      if (capacity <= 0) return 0;
      const rows = rowsOf<TelegramAiDraft>(
        await this.drafts.query(
          `UPDATE "notification_schema"."telegram_ai_drafts" d
              SET "worker_at" = now(), "worker_token" = gen_random_uuid(),
                  "updated_at" = now()
            WHERE d."id" IN (
                  SELECT "id" FROM "notification_schema"."telegram_ai_drafts"
                   WHERE "status" IN ('parsing', 'creating')
                     AND "worker_at" IS NULL AND "expires_at" > now()
                     AND "updated_at" < now() - ($2::int * interval '1 millisecond')
                   ORDER BY "updated_at"
                   LIMIT $1
                   FOR UPDATE SKIP LOCKED)
          RETURNING d.*`,
          [capacity, AI_TICK_MIN_AGE_MS],
        ),
      );
      for (const row of rows) {
        const job: Promise<void> = this.work(row).finally(() => {
          this.inflight.delete(job);
        });
        this.inflight.add(job);
      }
      return rows.length;
    } catch (error) {
      this.logger.error(
        `AI ishchisi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** 2 daqiqadan eski parsing → «🔁 Qayta urinish»; creating → preview. */
  private async recoverStale(): Promise<void> {
    const rows = rowsOf<TelegramAiDraft & { old_status: string }>(
      await this.drafts.query(
        `WITH stale AS (
           SELECT "id", "status" AS "old_status"
             FROM "notification_schema"."telegram_ai_drafts"
            WHERE "status" IN ('parsing', 'creating')
              AND "worker_at" IS NOT NULL
              AND "worker_at" < now() - ($1::int * interval '1 millisecond')
              AND "expires_at" > now()
            FOR UPDATE SKIP LOCKED)
         UPDATE "notification_schema"."telegram_ai_drafts" d
            SET "status" = CASE WHEN s."old_status" = 'parsing' THEN 'failed' ELSE 'preview' END,
                "worker_at" = NULL, "worker_token" = NULL, "updated_at" = now()
           FROM stale s
          WHERE d."id" = s."id"
        RETURNING d.*, s."old_status"`,
        [AI_STALE_AFTER_MS],
      ),
    );
    for (const row of rows) {
      const ctx = this.workerContext(row);
      try {
        if (row.old_status === 'creating') {
          await this.backToPreview(ctx, row, AI_CONFIRM_FAILED_TEXT);
        } else {
          await this.fail(ctx, row, AI_STALE_TEXT, true);
        }
      } catch (error) {
        this.logger.warn(
          `ai draft ${row.id}: qotgan holatni tiklab bo'lmadi — ${this.transport.describe(error)}`,
        );
      }
    }
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
          AI_BOT_IMAGE_MAX_BYTES,
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
      // Parol almashtirish shart — «⏳» xabari aniq ko'rsatma va
      // «🔁 Qayta urinish» bilan almashtiriladi (tugmasiz qotib qolmaydi);
      // router'ga qaytarilmaydi — ko'rsatma ikki marta chiqmasin.
      if (error instanceof BotPasswordChangeRequiredError) {
        await this.fail(ctx, draft, BOT_PASSWORD_CHANGE_TEXT, true);
        return;
      }
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
      if (!(await this.finish(draft, { status: 'empty' }))) return;
      await this.show(ctx, draft, AI_EMPTY_TEXT, []);
      return;
    }
    if (
      !(await this.finish(draft, {
        status: 'preview',
        orders,
        ai_draft_id: str(data.draft_id) || null,
        error: null,
      }))
    ) {
      return;
    }
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

  /**
   * `✅ Yaratish`: preview → creating (faqat bitta bosish o'tadi), "⏳" va
   * ai-confirm FONDA.
   */
  async confirm(ctx: BotContext, draftId: string): Promise<void> {
    const draft = await this.claim(draftId, ['preview'], 'creating');
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    await this.show(ctx, draft, AI_CREATING_TEXT, []);
    this.schedule(draft.id, 'creating');
  }

  private async runConfirm(
    ctx: BotContext,
    draft: TelegramAiDraft,
  ): Promise<void> {
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    const ready = previews.filter(isCreatable);
    const telegramId = ctx.fromId ?? ctx.chatId;
    let res: { status: number; body: unknown };
    try {
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
      // Parol almashtirilgach «✅ Yaratish» ni qayta bosish mumkin bo'lsin:
      // «Yaratilmoqda…» xabari ko'rsatma + preview tugmalari bilan almashadi.
      if (error instanceof BotPasswordChangeRequiredError) {
        await this.backToPreview(ctx, draft, BOT_PASSWORD_CHANGE_TEXT);
        return;
      }
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
    if (
      !(await this.finish(draft, {
        status: 'created',
        results,
      }))
    ) {
      return;
    }
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
    if (!(await this.finish(draft, { status: 'preview' }))) return;
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
    if (
      !(await this.finish(draft, {
        status: 'failed',
        error: text.slice(0, 300),
      }))
    ) {
      return;
    }
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
            SET "status" = $3, "worker_at" = NULL, "worker_token" = NULL,
                "updated_at" = now()
          WHERE "id" = $1 AND "status" = ANY($2::varchar[]) AND "expires_at" > now()
        RETURNING *`,
        [draftId, from, to],
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * (BOT-3b) Yakuniy yozuv. Ishchi olgan qoralama — faqat da'vo tokeni hali
   * SHU ish bo'lsa (`worker_token`): qotgan deb tiklangan / qayta urinilgan
   * qoralamaning kech natijasi tashlanadi (xabar ham tahrirlanmaydi) — AI
   * natijasi ustidan yozilmaydi, buyurtma ikki marta yaratilmaydi. Da'vo
   * tugaydi (`worker_*` NULL). `false` — natija tashlandi.
   */
  private async finish(
    draft: TelegramAiDraft,
    patch: Partial<
      Pick<
        TelegramAiDraft,
        'status' | 'orders' | 'ai_draft_id' | 'error' | 'results'
      >
    >,
  ): Promise<boolean> {
    const values = {
      ...patch,
      worker_at: null,
      worker_token: null,
      updated_at: new Date(),
    };
    if (!draft.worker_token) {
      await this.drafts.update({ id: draft.id }, values as never);
      return true;
    }
    const res = await this.drafts.update(
      { id: draft.id, worker_token: draft.worker_token },
      values as never,
    );
    if (res?.affected) {
      draft.worker_token = null;
      return true;
    }
    this.logger.warn(
      `ai draft ${draft.id}: natija kech keldi (qoralama boshqa holatda) — tashlandi`,
    );
    return false;
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
