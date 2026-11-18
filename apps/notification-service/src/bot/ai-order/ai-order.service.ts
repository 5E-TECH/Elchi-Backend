import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  cabinetBaseUrl,
  cabinetLinks,
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
import { BotSessionService } from '../bot-session.service';
import { BotTransportService } from '../bot-transport.service';
import type { BotContext } from '../handlers/bot-context';
import type { InlineKeyboardButton } from '../telegram.types';
import {
  AI_ACK_SERVER_ASKED_TEXT,
  AI_EDITS_NOT_APPLIED_TEXT,
  AiAckEntry,
  PREVIEW_MAX_ORDERS,
  confirmAttempted,
  confirmSendable,
  editedAfterAttempt,
  markConfirmAttempted,
  AiPreviewOrder,
  ackPromptText,
  ackTargets,
  aiPreviewText,
  isCreatable,
  isFullyAcked,
  toConfirmOrder,
} from './ai-preview';
import {
  AI_SEARCH_BAD_QUERY_TEXT,
  AI_SEARCH_FAILED_TEXT,
  AI_SEARCH_MAX_CHARS,
  AI_SEARCH_MIN_CHARS,
  AI_SEARCH_PROMPT_TEXT,
  type AiPickSource,
  applyKeepName,
  applyProductPick,
  applySearchResults,
  findItem,
  needsPick,
  optionLabel,
  pickEntries,
  pickEntryLabel,
  pickerText,
  productOptions,
  productsFromSearch,
} from './ai-product-pick';
import {
  AI_DISTRICT_LOAD_FAILED_TEXT,
  AI_DISTRICT_MAX_ENTRIES,
  AI_EDIT_INPUT_TTL_MS,
  AI_EDIT_MAX_ITEMS,
  endsEditInput,
  AI_EDIT_NO_DISTRICT_TEXT,
  type AiDistrictSource,
  type AiEditField,
  applyDistrictPick,
  applyFieldEdit,
  canPickDistrict,
  districtCandidates,
  districtPickerText,
  districtsFromResponse,
  editMenuText,
  editPromptText,
  isEditField,
  needsDistrict,
  parseEditValue,
  storedDistrictOptions,
} from './ai-order-edit';

export const AI_ORDER_ACTIONS = {
  confirm: 'ai.ok',
  /** AI ack: «Baribir yaratamanmi?» → «✅ Ha, yaratish». */
  ack: 'ai.ack',
  /** AI ack: «↩️ Yo‘q, orqaga» — preview'ga qaytadi, hech narsa yaratilmaydi. */
  back: 'ai.back',
  /** «✏️ Tuzatish» — tuzatish menyusi (bir nechta buyurtmada — avval tanlash). */
  fix: 'ai.fix',
  cancel: 'ai.no',
  retry: 'ai.retry',
  /** Katalogda topilmagan mahsulot: tanlash oynasini ochish. */
  item: 'ai.item',
  /** Tanlash oynasi: nomzod / qidiruv natijasini tanlash. */
  pick: 'ai.pick',
  /** Tanlash oynasi: «🔎 Qidirish» — keyingi matn qidiruv so'rovi. */
  find: 'ai.find',
  /** Tanlash oynasi: «📝 Nomi bilan qoldirish». */
  keep: 'ai.keep',
  /** Tuzatish: shu buyurtmaning maydonlar menyusi. */
  edit: 'ai.edit',
  /** Tuzatish: maydon tanlandi — keyingi matn yangi qiymat. */
  field: 'ai.field',
  /** Tuman tanlash oynasi (nomzodlar yoki viloyat tumanlari). */
  district: 'ai.dist',
  /** Tuman tanlandi. */
  districtPick: 'ai.dpick',
} as const;

/**
 * Operator matn kiritishini kutish (`telegram_sessions.state.ai_input`):
 * faqat id/indekslar va maydon kaliti (PII yo'q). Shundan eski kutish
 * e'tiborsiz.
 */
export const AI_INPUT_TTL_MS = 15 * 60_000;

interface AiInputState {
  draft_id: string;
  /** `search` — mahsulot qidiruvi; `edit` — maydonning yangi qiymati. */
  kind: 'search' | 'edit';
  o: number;
  /** Item o'rni (search / qty); boshqa maydonlarda -1. */
  i: number;
  /** `edit` da maydon. */
  f?: AiEditField;
  at: number;
}

const inputStateOf = (value: unknown): AiInputState | null => {
  const v = value as Partial<AiInputState> | null;
  if (
    !v ||
    typeof v.draft_id !== 'string' ||
    (v.kind !== 'search' && !(v.kind === 'edit' && isEditField(v.f))) ||
    !Number.isInteger(v.o) ||
    !Number.isInteger(v.i) ||
    typeof v.at !== 'number'
  ) {
    return null;
  }
  return v as AiInputState;
};

/**
 * Qidiruv kutilayotganda yangi buyurtma matni: ko'p qatorli yoki harf VA
 * 7+ raqam (ism + telefon). Shtrix-kod (8–14 raqam) va Elchi kodi
 * (`ELC-P-<n>`) — qidiruv so'rovi (pullik ai-parse emas).
 */
export function endsSearch(text: string): boolean {
  const trimmed = text.trim();
  if (/^(?:\d{8,14}|ELC-P-\d+)$/i.test(trimmed)) return false;
  return (
    /\n/.test(trimmed) ||
    (/\p{L}/u.test(trimmed) && (trimmed.match(/\d/g) ?? []).length >= 7)
  );
}

/** Kutish turi bo'yicha: matn yangi buyurtma bo'lsa kutish tugaydi. */
const endsInput = (input: AiInputState, text: string): boolean =>
  input.kind === 'edit' ? endsEditInput(input.f!, text) : endsSearch(text);

/** Kutish muddati: qidiruv 15 daqiqa, maydon qiymati 5 daqiqa. */
const inputTtl = (input: AiInputState): number =>
  input.kind === 'edit' ? AI_EDIT_INPUT_TTL_MS : AI_INPUT_TTL_MS;

export const AI_WORKING_TEXT = '⏳ AI buyurtmani o‘qiyapti… (1 daqiqagacha)';
export const AI_EXPIRED_TEXT =
  '⏳ Bu ro‘yxat eskirgan — matnni qayta yuboring.';
export const AI_EMPTY_TEXT =
  '🤷 Matndan buyurtma topilmadi — mijoz ismi, telefoni, manzili, mahsulot va narxini yozib yuboring.';
export const AI_NETWORK_TEXT =
  '❌ AI bilan aloqa bo‘lmadi. Matningiz saqlangan — «🔁 Qayta urinish» ni bosing.';
export const AI_CANCELLED_TEXT = '❌ Bekor qilindi — hech narsa yaratilmadi.';
/** Tuzatish: bir nechta buyurtma — qaysi biri. */
export const AI_EDIT_CHOOSE_TEXT =
  '✏️ Qaysi buyurtmani tuzatamiz? (Boshqa o‘zgarishlar — matnni tuzatib qayta yuboring yoki kabinetda yarating.)';
export const AI_CREATING_TEXT = '⏳ Buyurtmalar yaratilmoqda…';
export const AI_ALREADY_CREATED_TEXT = 'ℹ️ Bu ro‘yxat allaqachon yaratilgan.';
export const AI_CONFIRM_FAILED_TEXT =
  '❌ Javob olinmadi — «✅ Yaratish» ni qayta bosing (takroriy buyurtma yaratilmaydi).';
/** (AI ack S3) 503 `AI_CHECKS_UNAVAILABLE` — hech narsa yaratilmadi. */
export const AI_CHECKS_RETRY_TEXT =
  '⏳ AI tekshiruvlari hozircha tayyor emas — birozdan so‘ng qayta urinib ko‘ring («✅ Yaratish»). Hech narsa yaratilmadi.';
/** (AI ack S3) 400 `AI_DRAFT_*` — server AI natijasini topmadi. */
export const AI_DRAFT_GONE_TEXT =
  '❌ AI natijasi topilmadi — matnni qayta yuboring yoki buyurtmani kabinetda yarating. Hech narsa yaratilmadi.';
/** (AI ack B3) Tasdiqlanmagan ogohlantirishli buyurtma yuborilmadi. */
export const AI_UNACKED_SKIPPED_TEXT =
  'AI ogohlantirishi tasdiqlanmagan — kabinetda yarating';

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
/**
 * `preview` ga faqat shu holatlardan o'tiladi: yakunlangan (`created`,
 * `cancelled`, …) qoralama HECH QACHON qaytmaydi — masalan natija xabari
 * yuborilmay qolsa (show xatosi) buyurtma allaqachon yaratilgan.
 */
const PREVIEW_FROM_STATUSES: TelegramAiDraftStatus[] = [
  'parsing',
  'creating',
  'preview',
];

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

/** (AI ack) ai-confirm xato tanasi (gateway filtri — `code` + ro'yxatlar). */
interface ConfirmErrorBody {
  message?: unknown;
  code?: unknown;
  orders?: unknown;
}

/** «✅ Ha, yaratish» payload'idagi `acks` — faqat to'g'ri shakldagi yozuvlar. */
const ackEntriesOf = (value: unknown): AiAckEntry[] | null => {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry: unknown) => {
    const e = entry as { index?: unknown; codes?: unknown } | null;
    if (!e || !Number.isInteger(e.index) || !Array.isArray(e.codes)) return [];
    return [
      {
        index: e.index as number,
        codes: e.codes.filter((c): c is string => typeof c === 'string'),
      },
    ];
  });
};

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
    // Ixtiyoriy: matn kiritishini kutish (🔎 Qidirish). Eski spec'lar usiz quradi.
    @Optional() private readonly sessions?: BotSessionService,
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
    return cabinetBaseUrl(this.config.get<string>('ELCHI_CABINET_URL'));
  }

  cabinetCreateButton(): InlineKeyboardButton {
    return {
      text: '🌐 Kabinetda yaratish',
      // (PIJN1lGp) «Buyurtma yaratish» sahifasi (avvalgi yo'l mavjud emas edi).
      url: cabinetLinks(this.cabinetUrl).orderCreate(),
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
    // Ish bosqichi (da'vo paytidagi holat). `draft.status` muvaffaqiyatli
    // `finish` dan keyin yangilanadi — catch bosqichni SHUNDAN oladi, joriy
    // holatdan EMAS (aks holda `created` qoralama `fail` ga tushardi).
    const phase = draft.status;
    try {
      if (phase === 'creating') await this.runConfirm(ctx, draft);
      else await this.runParse(ctx, draft);
    } catch (error) {
      this.logger.warn(
        `ai draft ${draft.id}: ${phase} — ${this.transport.describe(error)}`,
      );
      await this.recover(ctx, draft, phase);
    }
  }

  /**
   * Ishchi xatosidan keyin holatni tiklash:
   *  - confirm, yakuniy yozuv bo'lmagan — natija noma'lum: preview + belgi;
   *  - confirm, natija aniq yozilgan (`preview`: 409 / tasdiq oynasi) — xabar
   *    yiqilgan, belgisiz preview;
   *  - confirm, `created` (yoki preview'ga qaytarish rad etildi va qoralama
   *    yaratilgan) — saqlangan natija yangi xabar bilan (dublikat bo'lmasin);
   *  - parse, natija yozilmagan — «🔁 Qayta urinish»; yozilgan (preview /
   *    empty) — `failed` ga AYLANTIRILMAYDI, faqat karta qayta (best-effort).
   */
  private async recover(
    ctx: BotContext,
    draft: TelegramAiDraft,
    phase: TelegramAiDraftStatus,
  ): Promise<void> {
    if (phase === 'creating') {
      if (draft.status === 'creating' || draft.status === 'preview') {
        const shown = await this.backToPreview(
          ctx,
          draft,
          AI_CONFIRM_FAILED_TEXT,
          draft.status === 'creating',
        );
        if (shown) return;
      }
      const row = await this.drafts.findOne({ where: { id: draft.id } });
      if (row?.status === 'created') await this.showCreated(ctx, row);
      return;
    }
    if (draft.status === phase) {
      await this.fail(ctx, draft, AI_NETWORK_TEXT, true);
      return;
    }
    if (draft.status === 'preview') {
      await this.showPreview(ctx, draft).catch((error: unknown) =>
        this.logger.warn(
          `ai draft ${draft.id}: preview qayta ko'rsatilmadi — ${this.transport.describe(error)}`,
        ),
      );
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
          // Qotgan ai-confirm — server yaratgan bo'lishi mumkin.
          await this.backToPreview(ctx, row, AI_CONFIRM_FAILED_TEXT, true);
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
    draft.orders = orders;
    await this.showPreview(ctx, draft);
  }

  /**
   * `✅ Yaratish`: preview → creating (faqat bitta bosish o'tadi), "⏳" va
   * ai-confirm FONDA.
   * AI ack (ega qarori 2026-11-14): tayyor buyurtmada bloklovchi tekshiruv
   * (tuman aniq emas / summa farq qiladi) bo'lsa, avval «Baribir
   * yaratamanmi?» — qoralama `preview` da qoladi, yaratish faqat
   * `✅ Ha, yaratish` (`ack`) dan keyin.
   */
  async confirm(ctx: BotContext, draftId: string): Promise<void> {
    if (await this.askAckConfirm(ctx, draftId)) return;
    await this.startCreating(ctx, draftId, []);
  }

  /**
   * AI ack: «✅ Ha, yaratish» — operator oynada RO'YXATLANGAN
   * ogohlantirishlarni ko'rdi. `acks` — AYNAN o'sha ro'yxat (tugma
   * payload'i); ai-confirm `ack_checks` faqat shulardan (B3). Eski tugma
   * (`acks` yo'q, deploy'dan oldin) — oyna qayta ko'rsatiladi.
   */
  async confirmAcked(
    ctx: BotContext,
    draftId: string,
    acks?: unknown,
  ): Promise<void> {
    const entries = ackEntriesOf(acks);
    if (!entries) {
      if (await this.askAckConfirm(ctx, draftId)) return;
      await this.startCreating(ctx, draftId, []);
      return;
    }
    await this.startCreating(ctx, draftId, entries);
  }

  /**
   * AI ack: «↩️ Yo‘q, orqaga» — preview tugmalari bilan qaytadi. Mahsulot
   * tanlash / qidiruv oynasidagi «↩️ Orqaga» ham shu (kutilgan matn bekor).
   */
  async backFromAck(ctx: BotContext, draftId: string): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.previewDraft(draftId);
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    await this.show(
      ctx,
      draft,
      aiPreviewText(previews),
      await this.previewRows(ctx, draft),
      'HTML',
    );
  }

  /** Bloklovchi tekshiruv bo'lsa qayta so'raydi (`true` — so'raldi). */
  private async askAckConfirm(
    ctx: BotContext,
    draftId: string,
  ): Promise<boolean> {
    const draft = await this.previewDraft(draftId);
    if (!draft) return false;
    return this.showAckPrompt(ctx, draft);
  }

  /**
   * (AI ack B3/S3) «Baribir yaratamanmi?» oynasi: har tasdiqlanadigan 🟢
   * buyurtma ANIQ ro'yxatda (bloklovchi qatorlari bilan). «✅ Ha, yaratish»
   * payload'i — AYNAN shu ro'yxat (`acks`), ya'ni operator ko'rmagan
   * ogohlantirish hech qachon tasdiqlanmaydi. Ro'yxat sig'masa «Ha» yo'q —
   * kabinet. `extra` — server 409 da so'ragan kodlar (preview `index` →
   * kodlar). `false` — tasdiq kerak emas.
   */
  private async showAckPrompt(
    ctx: BotContext,
    draft: TelegramAiDraft,
    extra?: ReadonlyMap<number, readonly string[]>,
    intro?: string,
  ): Promise<boolean> {
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    const targets = ackTargets(previews, extra);
    if (targets.length === 0) return false;
    const { text, fits } = ackPromptText(targets, intro);
    const back = await this.button(
      ctx,
      draft,
      '↩️ Yo‘q, orqaga',
      AI_ORDER_ACTIONS.back,
    );
    const rows: InlineKeyboardButton[][] = fits
      ? [
          [
            await this.button(
              ctx,
              draft,
              '✅ Ha, yaratish',
              AI_ORDER_ACTIONS.ack,
              {
                acks: targets.map(({ order, codes }): AiAckEntry => ({
                  index: order.index,
                  codes,
                })),
              },
            ),
            back,
          ],
        ]
      : [[this.cabinetCreateButton()], [back]];
    await this.show(ctx, draft, text, rows, 'HTML');
    return true;
  }

  /** Muddati o'tmagan `preview` holatidagi qoralama (aks holda null). */
  private async previewDraft(draftId: string): Promise<TelegramAiDraft | null> {
    if (!/^[0-9a-f-]{36}$/i.test(draftId)) return null;
    const draft = await this.drafts.findOne({ where: { id: draftId } });
    if (
      !draft ||
      draft.status !== 'preview' ||
      new Date(draft.expires_at).getTime() <= Date.now()
    ) {
      return null;
    }
    return draft;
  }

  private async startCreating(
    ctx: BotContext,
    draftId: string,
    acks: AiAckEntry[],
  ) {
    const draft = await this.claim(draftId, ['preview'], 'creating');
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    // (AI ack B3) Shu bosishdagi tasdiq — avvalgilari o'chiriladi: operator
    // ko'rgan ro'yxatdagi kodlargina `acked_checks` bo'ladi.
    const ackByIndex = new Map(acks.map((a) => [a.index, a.codes]));
    draft.orders = ((draft.orders ?? []) as AiPreviewOrder[]).map((order) => {
      const rest: AiPreviewOrder = { ...order };
      delete rest.acked_checks;
      const codes = ackByIndex.get(order.index);
      return codes?.length ? { ...rest, acked_checks: codes } : rest;
    });
    await this.drafts.update({ id: draft.id }, {
      orders: draft.orders,
    } as never);
    await this.show(ctx, draft, AI_CREATING_TEXT, []);
    this.schedule(draft.id, 'creating');
  }

  private async runConfirm(
    ctx: BotContext,
    draft: TelegramAiDraft,
  ): Promise<void> {
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    // (AI ack B3) Bloklovchi ogohlantirishi operatorga KO'RSATILIB
    // tasdiqlanmagan buyurtma yuborilmaydi — «kabinetda yarating».
    const ready = confirmSendable(previews);
    if (ready.length === 0) {
      // Hammasi tasdiq kutadi (masalan eski tugma) — oyna qayta.
      if (!(await this.finish(draft, { status: 'preview' }))) return;
      if (!(await this.showAckPrompt(ctx, draft))) {
        await this.backToPreview(ctx, draft, AI_CONFIRM_FAILED_TEXT);
      }
      return;
    }
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
      // Timeout / tarmoq — server yaratgan bo'lishi mumkin.
      await this.backToPreview(ctx, draft, AI_CONFIRM_FAILED_TEXT, true);
      return;
    }
    const body = res.body as
      ({ data?: { results?: ConfirmResult[] } } & ConfirmErrorBody) | null;
    if (
      res.status >= 400 &&
      (await this.handleAckError(ctx, draft, ready, res.status, body))
    ) {
      return;
    }
    if (res.status >= 400 || !Array.isArray(body?.data?.results)) {
      // 5xx / tushunarsiz 2xx — natija noma'lum; 4xx — server rad etdi.
      const unknown = res.status >= 500 || res.status < 400;
      await this.backToPreview(
        ctx,
        draft,
        unknown
          ? AI_CONFIRM_FAILED_TEXT
          : `❌ ${str(body?.message) || 'So‘rov qabul qilinmadi'}`,
        unknown,
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
    const { text, skipped } = this.createdSummary(previews, results);
    await this.show(
      ctx,
      draft,
      text,
      skipped ? [[this.cabinetCreateButton()]] : [],
    );
  }

  /**
   * ai-confirm natijasi matni (saqlangan `orders` + `results` dan — xabar
   * yuborilmay qolsa ham qayta tiklanadi). `skipped` — kabinetda
   * yaratiladigan buyurtma bor.
   */
  private createdSummary(
    previews: AiPreviewOrder[],
    results: ConfirmResult[],
  ): { text: string; skipped: boolean } {
    const creatable = previews.filter(isCreatable);
    const ready = creatable.filter(isFullyAcked);
    const unacked = creatable.filter((order) => !isFullyAcked(order));
    const lines = results.flatMap((result) => {
      const order = ready[result.index];
      const n = (order?.index ?? result.index) + 1;
      if (!result.ok)
        return [`❌ ${n}) ${str(result.reason) || 'yaratilmadi'}`];
      const line = `✅ ${n}) Buyurtma ${orderNumber(result.order_id)} ${result.idempotent_replay ? 'avval yaratilgan' : 'yaratildi'}`;
      // Takroriy javob — server birinchi urinish yukini qaytardi; undan
      // keyin qoralama o'zgargan bo'lsa tuzatishlar buyurtmada YO'Q.
      return result.idempotent_replay && order && editedAfterAttempt(order)
        ? [line, `⚠️ ${n}) ${AI_EDITS_NOT_APPLIED_TEXT}`]
        : [line];
    });
    for (const order of unacked) {
      lines.push(`⚠️ ${order.index + 1}) ${AI_UNACKED_SKIPPED_TEXT}`);
    }
    const incomplete = previews.length - creatable.length;
    if (incomplete > 0) {
      lines.push(
        `🟠 ${incomplete} ta buyurtma kamchilik bilan — kabinetda yarating.`,
      );
    }
    return {
      text: lines.join('\n'),
      skipped: incomplete + unacked.length > 0,
    };
  }

  /**
   * Buyurtmalar YARATILGAN, lekin natija xabari ko'rsatilmadi (show
   * yiqildi) — «⏳ Yaratilmoqda…» da qolmasin va operator matnni qayta
   * yuborib dublikat yaratmasin: saqlangan natija YANGI xabar bilan; bu
   * ham yiqilsa — «allaqachon yaratilgan» + kabinet havolasi.
   */
  private async showCreated(
    ctx: BotContext,
    row: TelegramAiDraft,
  ): Promise<void> {
    const results = Array.isArray(row.results)
      ? (row.results as ConfirmResult[])
      : [];
    try {
      const { text } = this.createdSummary(
        (row.orders ?? []) as AiPreviewOrder[],
        results,
      );
      await ctx.reply(text || AI_ALREADY_CREATED_TEXT, {
        reply_markup: { inline_keyboard: [[this.cabinetCreateButton()]] },
      });
    } catch (error) {
      this.logger.warn(
        `ai draft ${row.id}: natija xabari — ${this.transport.describe(error)}`,
      );
      await ctx
        .reply(AI_ALREADY_CREATED_TEXT, {
          reply_markup: { inline_keyboard: [[this.cabinetCreateButton()]] },
        })
        .catch(() => undefined);
    }
  }

  /**
   * (AI ack S3) ai-confirm AI ack xatolari — server matni EMAS, tushunarli
   * o'zbekcha javob. `true` — xato shu yerda hal qilindi.
   *  - 409 `CHECKS_NOT_ACKNOWLEDGED`: server `orders[].index` (yuborilgan
   *    ro'yxatdagi o'rin) → preview buyurtmasi; `missing` kodlari bilan
   *    oyna qayta ko'rsatiladi («✅ Ha» — aynan shu kodlar yuboriladi);
   *  - 503 `AI_CHECKS_UNAVAILABLE`: «birozdan so‘ng qayta urinib ko‘ring»;
   *  - 400 `AI_DRAFT_*`: AI natijasi topilmadi — qayta yuboring / kabinet.
   */
  private async handleAckError(
    ctx: BotContext,
    draft: TelegramAiDraft,
    sent: AiPreviewOrder[],
    status: number,
    body: ConfirmErrorBody | null,
  ): Promise<boolean> {
    const code = str(body?.code);
    if (status === 409 && code === 'CHECKS_NOT_ACKNOWLEDGED') {
      const extra = new Map<number, string[]>();
      for (const entry of Array.isArray(body?.orders) ? body.orders : []) {
        const e = entry as { index?: unknown; missing?: unknown } | null;
        const order = Number.isInteger(e?.index)
          ? sent[e?.index as number]
          : undefined;
        if (!order || !Array.isArray(e?.missing)) continue;
        extra.set(
          order.index,
          e.missing.filter((c): c is string => typeof c === 'string'),
        );
      }
      if (!(await this.finish(draft, { status: 'preview' }))) return true;
      if (
        !(await this.showAckPrompt(ctx, draft, extra, AI_ACK_SERVER_ASKED_TEXT))
      ) {
        await this.backToPreview(ctx, draft, AI_CONFIRM_FAILED_TEXT);
      }
      return true;
    }
    if (status === 503 && code === 'AI_CHECKS_UNAVAILABLE') {
      await this.backToPreview(ctx, draft, AI_CHECKS_RETRY_TEXT);
      return true;
    }
    if (status === 400 && code.startsWith('AI_DRAFT_')) {
      await this.fail(ctx, draft, AI_DRAFT_GONE_TEXT, false);
      return true;
    }
    return false;
  }

  /** `❌ Bekor` — preview yopiladi, hech narsa yaratilmaydi. */
  async close(ctx: BotContext, draftId: string) {
    await this.clearInput(ctx);
    const draft = await this.claim(
      draftId,
      ['preview', 'failed', 'empty'],
      'cancelled',
    );
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    await this.show(ctx, draft, AI_CANCELLED_TEXT, []);
  }

  /**
   * `✏️ Tuzatish` — qoralama ochiq qoladi: bitta buyurtma bo'lsa darhol
   * maydonlar menyusi, bir nechta bo'lsa avval buyurtma tanlanadi.
   */
  async editMenu(ctx: BotContext, draftId: string): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.previewDraft(draftId);
    if (!draft) {
      await this.explainState(ctx, draftId);
      return;
    }
    // Kartada ko'rinadiganlar (avval kesish, keyin filtr — indekslar karta
    // bilan mos). Natijasi noma'lum urinishdagi (belgili) buyurtma botda
    // tuzatilmaydi; hammasi belgili — karta qayta; bitta qolsa — darhol
    // uning menyusi.
    const orders = ((draft.orders ?? []) as AiPreviewOrder[])
      .slice(0, PREVIEW_MAX_ORDERS)
      .filter((o) => !confirmAttempted(o));
    if (!orders.length) {
      await this.showPreview(ctx, draft);
      return;
    }
    if (orders.length === 1) {
      await this.showEditMenu(ctx, draft, orders[0]);
      return;
    }
    const rows: InlineKeyboardButton[][] = [];
    for (const order of orders) {
      rows.push([
        await this.button(
          ctx,
          draft,
          `${order.index + 1}) ${str(order.customer_name).slice(0, 30) || '—'}`,
          AI_ORDER_ACTIONS.edit,
          { o: order.index },
        ),
      ]);
    }
    rows.push([
      await this.button(ctx, draft, '↩️ Orqaga', AI_ORDER_ACTIONS.back),
    ]);
    await this.show(ctx, draft, AI_EDIT_CHOOSE_TEXT, rows);
  }

  /** Tanlangan buyurtmaning maydonlar menyusi. */
  async editOrder(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, orderIndex);
    if (!draft) return;
    const order = ((draft.orders ?? []) as AiPreviewOrder[]).find(
      (o) => o.index === orderIndex,
    );
    if (!order) {
      await this.showPreview(ctx, draft);
      return;
    }
    await this.showEditMenu(ctx, draft, order);
  }

  /**
   * Maydon tanlandi (`f`, qty uchun `i`) — so'rov matni, keyingi oddiy
   * matn yangi qiymat (`ai_input`).
   */
  async editField(
    ctx: BotContext,
    draftId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const draft = await this.editableDraft(ctx, draftId, payload.o);
    if (!draft) return;
    const order = ((draft.orders ?? []) as AiPreviewOrder[]).find(
      (o) => o.index === payload.o,
    );
    const field = payload.f;
    const itemIndex = field === 'qty' ? payload.i : -1;
    if (
      !order ||
      !isEditField(field) ||
      !Number.isInteger(itemIndex) ||
      (field === 'qty' && !order.items?.[itemIndex as number]) ||
      !this.sessions
    ) {
      await this.showPreview(ctx, draft);
      return;
    }
    const state: AiInputState = {
      draft_id: draft.id,
      kind: 'edit',
      o: order.index,
      i: itemIndex as number,
      f: field,
      at: Date.now(),
    };
    await this.sessions.update(ctx.chatId, ctx.slug, (s) => ({
      state: { ...s.state, ai_input: state },
    }));
    await this.show(
      ctx,
      draft,
      editPromptText(order, field, itemIndex as number),
      [[await this.button(ctx, draft, '↩️ Orqaga', AI_ORDER_ACTIONS.back)]],
      'HTML',
    );
  }

  /** Kutilgan qiymat: tekshirish → saqlash → preview (yangi xabar). */
  private async editInput(
    ctx: BotContext,
    draft: TelegramAiDraft,
    input: AiInputState,
    text: string,
  ): Promise<boolean> {
    const field = input.f as AiEditField;
    const parsed = parseEditValue(field, text);
    if (!parsed.ok) {
      // Kutish davom etadi — operator qayta yozadi yoki «↩️ Orqaga».
      await ctx.reply(parsed.error);
      return true;
    }
    const orders = applyFieldEdit(
      (draft.orders ?? []) as AiPreviewOrder[],
      input.o,
      field,
      input.i,
      parsed.value,
    );
    await this.clearInput(ctx);
    if (!orders) return false;
    if (!(await this.saveOrders(draft, orders))) {
      await this.explainState(ctx, draft.id);
      return true;
    }
    await this.dropCard(ctx, draft);
    await this.showPreview(ctx, draft);
    return true;
  }

  /**
   * «📍 Tuman»: AI nomzodlari bo'lsa — ular; aks holda viloyat tumanlari
   * (`GET /district?region_id`, operator JWT) — qoralamada saqlanadi.
   */
  async openDistrict(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, orderIndex);
    if (!draft) return;
    let orders = (draft.orders ?? []) as AiPreviewOrder[];
    let order = orders.find((o) => o.index === orderIndex);
    if (!order) {
      await this.showPreview(ctx, draft);
      return;
    }
    const back = await this.button(
      ctx,
      draft,
      '↩️ Orqaga',
      AI_ORDER_ACTIONS.back,
    );
    let source: AiDistrictSource = 'c';
    let options = districtCandidates(order);
    if (!options.length) {
      source = 'r';
      options = storedDistrictOptions(order);
    }
    if (!options.length) {
      const regionId = str(order.region_id);
      if (!/^\d{1,20}$/.test(regionId)) {
        await this.show(ctx, draft, AI_EDIT_NO_DISTRICT_TEXT, [[back]]);
        return;
      }
      let res: { status: number; body: unknown };
      try {
        res = await this.gateway.request(
          ctx.fromId ?? ctx.chatId,
          'GET',
          `/district?region_id=${regionId}`,
        );
      } catch (error) {
        if (error instanceof BotPasswordChangeRequiredError) throw error;
        this.logger.warn(
          `ai draft ${draft.id}: tumanlar ro'yxati — ${error instanceof Error ? error.message : 'error'}`,
        );
        res = { status: 503, body: null };
      }
      const loaded =
        res.status < 400
          ? districtsFromResponse(res.body, order.region_name ?? null)
          : { options: [], total: 0 };
      options = loaded.options;
      if (!options.length) {
        await this.show(ctx, draft, AI_DISTRICT_LOAD_FAILED_TEXT, [[back]]);
        return;
      }
      orders = orders.map((o) =>
        o.index === order!.index
          ? {
              ...o,
              district_options: options,
              district_options_total: loaded.total,
            }
          : o,
      );
      if (!(await this.saveOrders(draft, orders))) {
        await this.explainState(ctx, draft.id);
        return;
      }
      order = orders.find((o) => o.index === orderIndex)!;
    }
    const current = str(order.district_id);
    const rows: InlineKeyboardButton[][] = [];
    // Viloyat tumanlari ko'p — ikkitadan qatorda.
    const perRow = source === 'r' ? 2 : 1;
    for (let k = 0; k < options.length; k += perRow) {
      const row: InlineKeyboardButton[] = [];
      for (const [j, option] of options.slice(k, k + perRow).entries()) {
        row.push(
          await this.button(
            ctx,
            draft,
            `${option.id === current ? '• ' : ''}${option.name}`,
            AI_ORDER_ACTIONS.districtPick,
            { o: order.index, s: source, k: k + j, did: option.id },
          ),
        );
      }
      rows.push(row);
    }
    rows.push([back]);
    await this.show(
      ctx,
      draft,
      districtPickerText(order, source),
      rows,
      'HTML',
    );
  }

  /**
   * Tuman tanlandi → `district_id` (operator tahriri: AI taklifidan farq
   * qilsa `district_low_confidence` tasdiq so'ramaydi — server ham), preview.
   */
  async pickDistrict(
    ctx: BotContext,
    draftId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, payload.o);
    if (!draft) return;
    const orders = (draft.orders ?? []) as AiPreviewOrder[];
    const order = orders.find((o) => o.index === payload.o);
    const list = !order
      ? []
      : payload.s === 'r'
        ? storedDistrictOptions(order)
        : districtCandidates(order);
    // `did` — tugma ko'rsatgan tuman; ro'yxat almashgan bo'lsa yozilmaydi.
    const candidate = Number.isInteger(payload.k)
      ? list[payload.k as number]
      : undefined;
    const option =
      candidate && candidate.id === payload.did ? candidate : undefined;
    await this.saveAndShow(
      ctx,
      draft,
      order && option ? applyDistrictPick(orders, order.index, option) : null,
    );
  }

  /** Maydonlar menyusi: ism / telefon / manzil / izoh / soni / tuman. */
  private async showEditMenu(
    ctx: BotContext,
    draft: TelegramAiDraft,
    order: AiPreviewOrder,
  ): Promise<void> {
    const o = order.index;
    const field = (text: string, f: AiEditField, i = -1) =>
      this.button(ctx, draft, text, AI_ORDER_ACTIONS.field, {
        o,
        f,
        ...(f === 'qty' ? { i } : {}),
      });
    const rows: InlineKeyboardButton[][] = [
      [await field('👤 Ism', 'name'), await field('📞 Telefon', 'phone')],
      [await field('🏠 Manzil', 'address'), await field('💬 Izoh', 'comment')],
    ];
    for (const [i, item] of (order.items ?? [])
      .slice(0, AI_EDIT_MAX_ITEMS)
      .entries()) {
      rows.push([
        await field(
          `🔢 Soni: ${str(item.resolved_name || item.name).slice(0, 30) || 'Mahsulot'}`,
          'qty',
          i,
        ),
      ]);
    }
    if (canPickDistrict(order)) {
      rows.push([
        await this.button(ctx, draft, '📍 Tuman', AI_ORDER_ACTIONS.district, {
          o,
        }),
      ]);
    }
    rows.push(
      [await this.button(ctx, draft, '↩️ Orqaga', AI_ORDER_ACTIONS.back)],
      [this.cabinetCreateButton()],
    );
    await this.show(ctx, draft, editMenuText(order), rows, 'HTML');
  }

  /** «❓ … — tanlash»: shu item uchun nomzodlar oynasi. */
  async openItem(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
    itemIndex: unknown,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, orderIndex);
    if (!draft) return;
    const found = findItem(
      (draft.orders ?? []) as AiPreviewOrder[],
      orderIndex,
      itemIndex,
    );
    if (!found || !needsPick(found.item)) {
      await this.showPreview(ctx, draft);
      return;
    }
    await this.showPicker(ctx, draft, found.order, itemIndex as number, 'c');
  }

  /**
   * Nomzod / qidiruv natijasi tanlandi → `product_id`, preview qayta.
   * Payload'dagi `pid` ro'yxatdagi o'rin bilan mos kelmasa (eski qidiruv
   * xabarining tugmasi) — hech narsa yozilmaydi, joriy ro'yxat qayta.
   */
  async pickProduct(
    ctx: BotContext,
    draftId: string,
    payload: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, payload?.o);
    if (!draft) return;
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    const orders = applyProductPick(
      previews,
      payload?.o,
      payload?.i,
      payload?.s,
      payload?.k,
      payload?.pid,
    );
    const found = findItem(previews, payload?.o, payload?.i);
    if (!orders && found && needsPick(found.item)) {
      await this.showPicker(
        ctx,
        draft,
        found.order,
        payload?.i as number,
        payload?.s === 's' ? 's' : 'c',
      );
      return;
    }
    await this.saveAndShow(ctx, draft, orders);
  }

  /**
   * Botda tuzatish mumkin bo'lgan qoralama: `preview` va buyurtma natijasi
   * noma'lum ai-confirm urinishida emas (aks holda karta qayta). `null` —
   * javob berildi.
   */
  private async editableDraft(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
  ): Promise<TelegramAiDraft | null> {
    const draft = await this.previewDraft(draftId);
    if (!draft) {
      await this.clearInput(ctx);
      await this.explainState(ctx, draftId);
      return null;
    }
    const order = ((draft.orders ?? []) as AiPreviewOrder[]).find(
      (o) => o.index === orderIndex,
    );
    if (confirmAttempted(order)) {
      await this.clearInput(ctx);
      await this.showPreview(ctx, draft);
      return null;
    }
    return draft;
  }

  /** «📝 Nomi bilan qoldirish» — katalogsiz yaratiladi, preview qayta. */
  async keepName(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
    itemIndex: unknown,
  ): Promise<void> {
    await this.clearInput(ctx);
    const draft = await this.editableDraft(ctx, draftId, orderIndex);
    if (!draft) return;
    const orders = applyKeepName(
      (draft.orders ?? []) as AiPreviewOrder[],
      orderIndex,
      itemIndex,
    );
    await this.saveAndShow(ctx, draft, orders);
  }

  /** «🔎 Qidirish» — keyingi oddiy matn shu item uchun qidiruv so'rovi. */
  async startSearch(
    ctx: BotContext,
    draftId: string,
    orderIndex: unknown,
    itemIndex: unknown,
  ): Promise<void> {
    const draft = await this.editableDraft(ctx, draftId, orderIndex);
    if (!draft) return;
    const found = findItem(
      (draft.orders ?? []) as AiPreviewOrder[],
      orderIndex,
      itemIndex,
    );
    if (!found || !needsPick(found.item) || !this.sessions) {
      await this.showPreview(ctx, draft);
      return;
    }
    const state: AiInputState = {
      draft_id: draft.id,
      kind: 'search',
      o: found.order.index,
      i: itemIndex as number,
      at: Date.now(),
    };
    await this.sessions.update(ctx.chatId, ctx.slug, (s) => ({
      state: { ...s.state, ai_input: state },
    }));
    await this.show(ctx, draft, AI_SEARCH_PROMPT_TEXT, [
      [await this.button(ctx, draft, '↩️ Orqaga', AI_ORDER_ACTIONS.back)],
    ]);
  }

  /**
   * Kutilgan matn (🔎 qidiruv so'rovi). `false` — kutish yo'q / eskirgan /
   * matn yangi buyurtmaga o'xshaydi: handler odatdagidek (AI) ishlaydi.
   */
  async handleInput(
    ctx: BotContext,
    actorUserId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.sessions) return false;
    const session = await this.sessions.load(ctx.chatId, ctx.slug);
    const input = inputStateOf(session.state?.ai_input);
    if (!input) return false;
    if (Date.now() - input.at > inputTtl(input) || endsInput(input, text)) {
      await this.clearInput(ctx);
      return false;
    }
    const draft = await this.previewDraft(input.draft_id);
    // Qoralama shu aktor va shu chatniki bo'lishi shart (masalan chatga
    // boshqa akkaunt ulangan) — aks holda kutish bekor, matn odatdagidek.
    if (
      draft &&
      (String(draft.actor_user_id) !== String(actorUserId) ||
        String(draft.chat_id) !== String(ctx.chatId))
    ) {
      await this.clearInput(ctx);
      return false;
    }
    if (!draft) {
      // Eskirgan qoralama — tugmalardagi kabi aniq javob; boshqa holat
      // (yaratilgan / bekor) — matn odatdagidek ishlanadi.
      await this.clearInput(ctx);
      const row = await this.drafts.findOne({ where: { id: input.draft_id } });
      if (row && new Date(row.expires_at).getTime() > Date.now()) return false;
      await ctx.reply(AI_EXPIRED_TEXT);
      return true;
    }
    // Natijasi noma'lum urinishdagi buyurtma — tuzatish yopiq.
    if (
      confirmAttempted(
        ((draft.orders ?? []) as AiPreviewOrder[]).find(
          (o) => o.index === input.o,
        ),
      )
    ) {
      await this.clearInput(ctx);
      await this.dropCard(ctx, draft);
      await this.showPreview(ctx, draft);
      return true;
    }
    return input.kind === 'edit'
      ? this.editInput(ctx, draft, input, text)
      : this.searchInput(ctx, draft, input, text);
  }

  /** «🔎 Qidirish» so'rovi → my-products → natijalar oynasi. */
  private async searchInput(
    ctx: BotContext,
    draft: TelegramAiDraft,
    input: AiInputState,
    text: string,
  ): Promise<boolean> {
    const found = findItem(
      (draft.orders ?? []) as AiPreviewOrder[],
      input.o,
      input.i,
    );
    if (!found || !needsPick(found.item)) {
      await this.clearInput(ctx);
      return false;
    }
    const query = text.replace(/\s+/g, ' ').trim();
    if (
      query.length < AI_SEARCH_MIN_CHARS ||
      query.length > AI_SEARCH_MAX_CHARS
    ) {
      await ctx.reply(AI_SEARCH_BAD_QUERY_TEXT);
      return true;
    }
    let res: { status: number; body: unknown };
    try {
      res = await this.gateway.request(
        ctx.fromId ?? ctx.chatId,
        'GET',
        `/product/my-products?search=${encodeURIComponent(query)}&page=1&limit=5`,
      );
    } catch (error) {
      // Parol almashtirish — router aniq ko'rsatma beradi.
      if (error instanceof BotPasswordChangeRequiredError) throw error;
      this.logger.warn(
        `ai draft ${draft.id}: mahsulot qidiruvi — ${error instanceof Error ? error.message : 'error'}`,
      );
      await ctx.reply(AI_SEARCH_FAILED_TEXT);
      return true;
    }
    if (res.status >= 400) {
      await ctx.reply(AI_SEARCH_FAILED_TEXT);
      return true;
    }
    const results = productsFromSearch(res.body);
    const orders = applySearchResults(
      (draft.orders ?? []) as AiPreviewOrder[],
      input.o,
      input.i,
      results,
    );
    if (!(await this.saveOrders(draft, orders))) {
      await this.clearInput(ctx);
      await this.explainState(ctx, draft.id);
      return true;
    }
    // Natija bor — kutish tugaydi (yana — «🔎 Qayta qidirish»); topilmasa
    // operator darhol boshqa nom yozishi mumkin.
    if (results.length) await this.clearInput(ctx);
    const order = orders.find((o) => o.index === input.o)!;
    // Operator matn yozdi — karta pastga (yangi xabar) ko'chadi.
    await this.dropCard(ctx, draft);
    await this.showPicker(ctx, draft, order, input.i, 's', query);
    return true;
  }

  /** Tanlash oynasi: ro'yxat (≤5) + 🔎 Qidirish + 📝 Nomi bilan + ↩️ Orqaga. */
  private async showPicker(
    ctx: BotContext,
    draft: TelegramAiDraft,
    order: AiPreviewOrder,
    itemIndex: number,
    source: AiPickSource,
    query?: string,
  ): Promise<void> {
    const item = order.items![itemIndex];
    const options = productOptions(
      source === 's' ? item.search_results : item.candidates,
    );
    const ref = { o: order.index, i: itemIndex };
    const rows: InlineKeyboardButton[][] = [];
    for (const [k, option] of options.entries()) {
      rows.push([
        await this.button(
          ctx,
          draft,
          optionLabel(option),
          AI_ORDER_ACTIONS.pick,
          // `pid` — eski xabardagi tugma boshqa ro'yxatdan tanlamasin.
          { ...ref, s: source, k, pid: option.id },
        ),
      ]);
    }
    rows.push(
      [
        await this.button(
          ctx,
          draft,
          source === 's' ? '🔎 Qayta qidirish' : '🔎 Qidirish',
          AI_ORDER_ACTIONS.find,
          ref,
        ),
        await this.button(
          ctx,
          draft,
          '📝 Nomi bilan qoldirish',
          AI_ORDER_ACTIONS.keep,
          ref,
        ),
      ],
      [await this.button(ctx, draft, '↩️ Orqaga', AI_ORDER_ACTIONS.back)],
    );
    await this.show(
      ctx,
      draft,
      pickerText(order, item, source, options, query),
      rows,
      'HTML',
    );
  }

  /** Preview kartasi (joriy `orders` bilan) va tugmalari. */
  private async showPreview(
    ctx: BotContext,
    draft: TelegramAiDraft,
  ): Promise<void> {
    await this.show(
      ctx,
      draft,
      aiPreviewText((draft.orders ?? []) as AiPreviewOrder[]),
      await this.previewRows(ctx, draft),
      'HTML',
    );
  }

  /** O'zgargan `orders` → saqlash → preview. `null` — o'zgarish yo'q. */
  private async saveAndShow(
    ctx: BotContext,
    draft: TelegramAiDraft,
    orders: AiPreviewOrder[] | null,
  ): Promise<void> {
    if (orders && !(await this.saveOrders(draft, orders))) {
      await this.explainState(ctx, draft.id);
      return;
    }
    await this.showPreview(ctx, draft);
  }

  /**
   * Faqat hali `preview` dagi qoralamaga yoziladi: parallel «✅ Yaratish»
   * (`creating`) dan keyin tanlash yaratilayotgan ro'yxatni o'zgartirmaydi.
   */
  private async saveOrders(
    draft: TelegramAiDraft,
    orders: AiPreviewOrder[],
  ): Promise<boolean> {
    const res = await this.drafts.update(
      { id: draft.id, status: 'preview' },
      { orders, updated_at: new Date() },
    );
    if (!res?.affected) return false;
    draft.orders = orders;
    return true;
  }

  /**
   * Operator matn yozgach karta pastga (yangi xabar) ko'chadi: eski
   * xabarning tugmalari olib tashlanadi, `show` yangi xabar yuboradi.
   */
  private async dropCard(
    ctx: BotContext,
    draft: TelegramAiDraft,
  ): Promise<void> {
    if (!draft.message_id) return;
    await this.transport
      .editMessage(ctx.chatId, String(draft.message_id), {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => false);
    draft.message_id = null;
  }

  /** Kutilgan matn holatini tozalaydi (bo'lsa). */
  private async clearInput(ctx: BotContext): Promise<void> {
    if (!this.sessions) return;
    const session = await this.sessions.load(ctx.chatId, ctx.slug);
    if (!session.state?.ai_input) return;
    await this.sessions.update(ctx.chatId, ctx.slug, (s) => {
      const state = { ...s.state };
      delete state.ai_input;
      return { state };
    });
  }

  /**
   * Preview'ga qaytadi. `unknownOutcome` — ai-confirm natijasi noma'lum
   * (yuborilgan bo'lishi mumkin): yuborilgan buyurtmalar belgilanadi va
   * botda tuzatish yopiladi (server kaliti birinchi yukni qaytaradi).
   * Server aniq hech narsa yaratmagan holatlarda (409 / 503 / 4xx / parol)
   * belgi QO'YILMAYDI.
   */
  private async backToPreview(
    ctx: BotContext,
    draft: TelegramAiDraft,
    text: string,
    unknownOutcome = false,
  ): Promise<boolean> {
    const patch: Partial<Pick<TelegramAiDraft, 'status' | 'orders'>> = {
      status: 'preview',
    };
    if (unknownOutcome) {
      const previews = (draft.orders ?? []) as AiPreviewOrder[];
      patch.orders = markConfirmAttempted(
        previews,
        confirmSendable(previews),
        Date.now(),
      );
    }
    if (!(await this.finish(draft, patch))) return false;
    if (patch.orders) draft.orders = patch.orders;
    const rows = await this.previewRows(ctx, draft);
    const previews = (draft.orders ?? []) as AiPreviewOrder[];
    await this.show(
      ctx,
      draft,
      `${aiPreviewText(previews)}\n\n${text}`,
      rows,
      'HTML',
    );
    return true;
  }

  /**
   * Preview tugmalari: ✅ Yaratish (tayyor buyurtma bo'lsa) / «❓ … —
   * tanlash» (katalogda topilmagan mahsulotlar) / ✏️ Tuzatish / ❌ Bekor.
   */
  private async previewRows(
    ctx: BotContext,
    draft: TelegramAiDraft,
  ): Promise<InlineKeyboardButton[][]> {
    const orders = (draft.orders ?? []) as AiPreviewOrder[];
    const rows: InlineKeyboardButton[][] = [];
    if (orders.some(isCreatable)) {
      rows.push([
        await this.button(ctx, draft, '✅ Yaratish', AI_ORDER_ACTIONS.confirm),
      ]);
    }
    // Natijasi noma'lum urinishdagi (belgili) buyurtma — botda tuzatilmaydi
    // (keyingi «✅» da server birinchi yukni qaytaradi): uning 📍 / ❓
    // tugmalari yo'q. Yuborilmagan (belgisiz) buyurtmalar odatdagidek.
    // Avval kartada ko'rinadiganlar (≤10), keyin belgisizlar — tugma kartada
    // yo'q (11+) buyurtmaga ishora qilmasin.
    const shown = orders.slice(0, PREVIEW_MAX_ORDERS);
    const editable = shown.filter((o) => !confirmAttempted(o));
    const locked = orders.some(confirmAttempted);
    const multi = orders.length > 1;
    // Tuman yo'q / AI ikkilangan — nomzod yoki viloyat bo'lsa botda tanlanadi.
    for (const order of editable
      .filter((o) => needsDistrict(o) && canPickDistrict(o))
      .slice(0, AI_DISTRICT_MAX_ENTRIES)) {
      rows.push([
        await this.button(
          ctx,
          draft,
          `📍 ${multi ? `${order.index + 1}) ` : ''}Tumanni tanlash`,
          AI_ORDER_ACTIONS.district,
          { o: order.index },
        ),
      ]);
    }
    for (const { order, itemIndex, item } of pickEntries(editable)) {
      rows.push([
        await this.button(
          ctx,
          draft,
          pickEntryLabel(order, item, multi),
          AI_ORDER_ACTIONS.item,
          { o: order.index, i: itemIndex },
        ),
      ]);
    }
    const cancel = await this.button(
      ctx,
      draft,
      '❌ Bekor',
      AI_ORDER_ACTIONS.cancel,
    );
    if (!locked) {
      return [
        ...rows,
        [
          await this.button(ctx, draft, '✏️ Tuzatish', AI_ORDER_ACTIONS.fix),
          cancel,
        ],
      ];
    }
    // Belgili buyurtma bor: ✏️ faqat belgisizlari bo'lsa; kabinet — doim.
    return [
      ...rows,
      editable.length
        ? [
            await this.button(ctx, draft, '✏️ Tuzatish', AI_ORDER_ACTIONS.fix),
            cancel,
          ]
        : [cancel],
      [this.cabinetCreateButton()],
    ];
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
    if (
      patch.status === 'preview' &&
      !PREVIEW_FROM_STATUSES.includes(draft.status)
    ) {
      this.logger.warn(
        `ai draft ${draft.id}: preview'ga qaytarilmadi (qoralama ${draft.status})`,
      );
      return false;
    }
    const applied = () => {
      draft.worker_token = null;
      if (patch.status) draft.status = patch.status;
      return true;
    };
    if (!draft.worker_token) {
      // Da'vo bo'shatilgan (shu ish oldingi `finish` bilan) — yozuv faqat
      // qoralama hali biz bilgan holatda bo'lsa: orada yangi da'vo
      // (masalan «✅» → `creating`) yoki yakuniy holat ustidan yozilmaydi.
      const res = await this.drafts.update(
        { id: draft.id, status: draft.status },
        values as never,
      );
      if (res?.affected) return applied();
      this.logger.warn(
        `ai draft ${draft.id}: yozuv tashlandi (qoralama ${draft.status} emas)`,
      );
      return false;
    }
    const res = await this.drafts.update(
      {
        id: draft.id,
        worker_token: draft.worker_token,
        ...(patch.status === 'preview'
          ? { status: In(PREVIEW_FROM_STATUSES) }
          : {}),
      },
      values as never,
    );
    if (res?.affected) return applied();
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
    extra: Record<string, unknown> = {},
  ): Promise<InlineKeyboardButton> {
    return {
      text,
      callback_data: await this.actions.create({
        chatId: ctx.chatId,
        action,
        actorUserId: String(draft.actor_user_id),
        // (AI ack B3) `extra` — masalan «✅ Ha» ning `acks` ro'yxati (PII yo'q).
        payload: { ...extra, draft_id: draft.id },
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
