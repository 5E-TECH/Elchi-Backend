import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { checkStagingOutbound } from '@app/common';
import { isUsableBotToken } from './bot-config';
import { botSendLatencyMs, botSendTotal } from './bot-metrics';
import type {
  InlineKeyboardMarkup,
  TelegramParseMode,
  TelegramBotIdentity,
  TelegramUpdate,
} from './telegram.types';

/**
 * (ZlpXb4Wh / Mvx0h1Fv / GL2GgtEc) Telegram Bot API bilan YAGONA aloqa nuqtasi.
 *
 * Repoda `api.telegram.org` satri FAQAT shu faylda uchraydi (grep-guard
 * spec'i tekshiradi). Bu yerda:
 *  - har chaqiruvga timeout (`AbortSignal.timeout`) — osilgan soket RMQ
 *    iste'molchisini to'sib qo'ymasin;
 *  - xato turlari ajratiladi (`TelegramApiError.kind`): 403 bloklangan →
 *    qayta URINILMAYDI; 429 → `retry_after` kutiladi; 5xx/tarmoq → qisqa
 *    eksponensial backoff; 401/404 (buzuq token) → darhol;
 *  - chiquvchi token-bucket: global ~25 xabar/s, guruh chatiga ~20/daqiqa;
 *  - Telegram qattiq chegaralari: xabar 4096 belgi (bo'linadi), callback_data
 *    64 bayt (oshsa — dasturchi xatosi, yuborilmaydi);
 *  - loglarda token HECH QACHON chop etilmaydi (`redactToken`).
 */
export const TELEGRAM_LIMITS = {
  MESSAGE_MAX_CHARS: 4096,
  CALLBACK_DATA_MAX_BYTES: 64,
  /** `getFile` orqali yuklab olinadigan fayl chegarasi (Bot API). */
  GET_FILE_MAX_BYTES: 20 * 1024 * 1024,
  /** Chiquvchi: global xabar/s (Telegram ~30/s dan past). */
  GLOBAL_SEND_PER_SEC: 25,
  /** Chiquvchi: bitta guruh chatiga xabar/daqiqa. */
  GROUP_SEND_PER_MIN: 20,
} as const;

/** Yagona joy — boshqa fayllar (spec'lar ham) shu doimiydan foydalanadi. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SEC = 60;
const SEND_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendVideo',
  'sendDocument',
  'sendMediaGroup',
  'editMessageText',
  'editMessageReplyMarkup',
]);
/** Telegram media izohi (caption) chegarasi. */
const CAPTION_MAX_CHARS = 1024;

export type TelegramErrorKind =
  | 'blocked'
  | 'rate_limited'
  | 'unauthorized'
  | 'retryable'
  | 'bad_request'
  /** (BOT-3 #6) guruh supergroup'ga aylangan — `migrateToChatId` bor. */
  | 'migrated';

/** Bot API xatosi. `description` da token bo'lmaydi (redaktsiya qilingan). */
export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;

  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfterSec: number | null,
    /**
     * (BOT-3 #6) Guruh supergroup'ga aylangan: Telegram 400 bilan YANGI chat
     * id'sini beradi (`parameters.migrate_to_chat_id`). Xabar yangi id'ga
     * qayta yuboriladi, ulanish ko'chiriladi.
     */
    readonly migrateToChatId: string | null = null,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
    this.kind = migrateToChatId
      ? 'migrated'
      : classifyTelegramError(status, description);
  }
}

/** `parameters.migrate_to_chat_id` → satr (yo'q / buzuq — null). */
export function migrateTargetOf(parameters: unknown): string | null {
  const raw = (parameters as { migrate_to_chat_id?: unknown } | null)
    ?.migrate_to_chat_id;
  return (typeof raw === 'number' || typeof raw === 'string') &&
    /^-?\d{1,20}$/.test(String(raw))
    ? String(raw)
    : null;
}

export function classifyTelegramError(
  status: number,
  description: string,
): TelegramErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 404) return 'unauthorized';
  if (status === 403) return 'blocked';
  if (status === 0 || status >= 500) return 'retryable';
  // 400 "chat not found" — chat o'chgan / bot chiqarilgan: qayta urinish befoyda.
  // (BOT-3 #6) "not enough rights" — botdan yozish huquqi olingan: guruh
  // nofaol (`blocked_on_send`) + admin xabari. HTML xatosi (can't parse
  // entities) esa `bad_request` — faqat shu xabar dead, guruh FAOL qoladi.
  if (
    /chat not found|bot was kicked|user is deactivated|not enough rights|have no rights/i.test(
      description,
    )
  ) {
    return 'blocked';
  }
  return 'bad_request';
}

/** Matndagi har qanday bot tokenini yashiradi (`bot<id>:<secret>`). */
export function redactToken(text: string, token?: string | null): string {
  let out = String(text ?? '').replace(
    /bot\d{3,}:[A-Za-z0-9_-]{10,}/g,
    'bot<redacted>',
  );
  if (token && token.length >= 8) out = out.split(token).join('<redacted>');
  return out;
}

/** UTF-8 bayt uzunligi (callback_data chegarasi BAYT bo'yicha). */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Inline klaviaturadagi har callback_data ≤ 64 bayt bo'lishi shart. */
export function assertCallbackDataFits(markup?: InlineKeyboardMarkup): void {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      const data = button.callback_data;
      if (
        data !== undefined &&
        utf8Bytes(data) > TELEGRAM_LIMITS.CALLBACK_DATA_MAX_BYTES
      ) {
        throw new Error(
          `callback_data ${utf8Bytes(data)} bayt — 64 baytdan oshmasligi kerak (qisqa id ishlating)`,
        );
      }
    }
  }
}

/**
 * Uzun xabarni ≤4096 belgili bo'laklarga bo'ladi — iloji bo'lsa qator
 * chegarasidan. Bo'sh matn bitta bo'sh bo'lak emas, [] qaytaradi.
 */
export function splitMessage(
  text: string,
  max: number = TELEGRAM_LIMITS.MESSAGE_MAX_CHARS,
): string[] {
  const chunks: string[] = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * (staging-safe) APP_ENV=staging da chat STAGING_TELEGRAM_CHAT_ALLOWLIST da
 * yo'q (yoki allowlist bo'sh) — Telegram'ga so'rov KETMAYDI. Status 400 →
 * `kind='bad_request'`: outbox qatorni darhol `dead` qiladi (qayta
 * urinilmaydi) va kanal nofaol QILINMAYDI (bu 403 emas — chat tirik).
 */
export class TelegramStagingBlockedError extends TelegramApiError {
  readonly stagingBlocked = true;

  constructor(method: string, reason: string) {
    super(method, 400, reason, null);
    this.name = 'TelegramStagingBlockedError';
  }
}

/**
 * `chat_id` li HAR metod (sendMessage/sendPhoto/sendDocument/sendMediaGroup/
 * editMessageText/editMessageReplyMarkup …) shu tekshiruvdan o'tadi.
 * `chat_id` siz metodlar (getMe, getUpdates, getFile, answerCallbackQuery,
 * setWebhook) — kimgadir xabar yubormaydi, o'tkaziladi.
 * production/development'da hech narsa qilmaydi.
 */
export function assertTelegramChatAllowedInEnv(
  method: string,
  chatId: unknown,
): void {
  if (chatId === undefined || chatId === null || chatId === '') return;
  const decision = checkStagingOutbound('telegram', chatId);
  if (!decision.allowed) {
    throw new TelegramStagingBlockedError(
      method,
      decision.reason ?? 'staging_blocked',
    );
  }
}

/** Metrika yorlig'i: 429/5xx — qayta urinish, 403 — bloklangan. */
function sendResultOf(error: unknown): string {
  if (!(error instanceof TelegramApiError)) return 'failed';
  if (error.kind === 'rate_limited' || error.kind === 'retryable') {
    return 'retry';
  }
  return error.kind === 'blocked' ? 'blocked' : 'failed';
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Bitta Bot API chaqiruvi (qayta urinishsiz). Script (`telegram-setup.ts`)
 * ham shu funksiyadan foydalanadi — URL boshqa joyda yozilmaydi.
 */
export async function callTelegramApi<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<T> {
  assertTelegramChatAllowedInEnv(method, payload?.chat_id);
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    throw new TelegramApiError(method, 0, redactToken(message, token), null);
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number; migrate_to_chat_id?: unknown };
  } | null;
  if (!response.ok || !body || body.ok !== true) {
    const retryAfter = Number(body?.parameters?.retry_after);
    throw new TelegramApiError(
      method,
      response.status,
      redactToken(body?.description ?? `HTTP ${response.status}`, token),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      migrateTargetOf(body?.parameters),
    );
  }
  return body.result as T;
}

/** Multipart chaqiruv (fayl yuborish) — URL faqat shu faylda. */
export async function callTelegramApiMultipart<T>(
  token: string,
  method: string,
  form: FormData,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<T> {
  assertTelegramChatAllowedInEnv(method, form.get('chat_id'));
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    throw new TelegramApiError(method, 0, redactToken(message, token), null);
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number; migrate_to_chat_id?: unknown };
  } | null;
  if (!response.ok || !body || body.ok !== true) {
    const retryAfter = Number(body?.parameters?.retry_after);
    throw new TelegramApiError(
      method,
      response.status,
      redactToken(body?.description ?? `HTTP ${response.status}`, token),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      migrateTargetOf(body?.parameters),
    );
  }
  return body.result as T;
}

/** Oddiy token-bucket (millisekund aniqlikda, sinov uchun soat in'ektsiya qilinadi). */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Token bo'lsa 0, aks holda keyingisigacha kutish (ms). */
  take(): number {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.last) * this.refillPerMs,
    );
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
}

/**
 * (bOMYoOtV) Token FAQAT env'dan (`TELEGRAM_BOT_TOKEN`) — chaqiruvchi
 * (so'rov tanasi, DB) token BERA OLMAYDI.
 */
export interface BotCallOptions {
  /** Chiquvchi cheklov uchun chat (guruh chatlari daqiqasiga ~20). */
  chatId?: string;
  /** 429 va 5xx da umumiy urinishlar soni (sukut 4). */
  maxAttempts?: number;
  timeoutMs?: number;
}

@Injectable()
export class BotTransportService {
  private readonly logger = new Logger(BotTransportService.name);
  private readonly envToken: string;
  private readonly globalBucket: TokenBucket;
  private readonly groupBuckets = new Map<string, TokenBucket>();
  /** Sinovlarda almashtiriladi. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  fetchImpl: FetchLike = (url, init) => fetch(url, init);
  now: () => number = Date.now;

  constructor(@Optional() config?: ConfigService) {
    this.envToken = String(
      config?.get<string>('TELEGRAM_BOT_TOKEN') ??
        process.env.TELEGRAM_BOT_TOKEN ??
        '',
    ).trim();
    this.globalBucket = new TokenBucket(
      TELEGRAM_LIMITS.GLOBAL_SEND_PER_SEC,
      TELEGRAM_LIMITS.GLOBAL_SEND_PER_SEC / 1000,
      () => this.now(),
    );
  }

  /** Env tokeni (bo'sh yoki placeholder bo'lsa ''). */
  get defaultToken(): string {
    return isUsableBotToken(this.envToken) ? this.envToken : '';
  }

  /**
   * Qayta urinishli chaqiruv. 403/401/404/400 — darhol throw; 429 —
   * `retry_after` (≤60 s) kutiladi; 5xx/tarmoq — 500 ms × 2^n.
   */
  async call<T>(
    method: string,
    payload: Record<string, unknown>,
    options: BotCallOptions = {},
  ): Promise<T> {
    const token = this.defaultToken;
    if (!token) {
      throw new TelegramApiError(
        method,
        401,
        'bot token is not configured',
        null,
      );
    }
    const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    for (let attempt = 1; ; attempt += 1) {
      const isSend = SEND_METHODS.has(method);
      if (isSend) await this.throttle(options.chatId);
      const startedAt = this.now();
      try {
        const result = await callTelegramApi<T>(token, method, payload, {
          timeoutMs: options.timeoutMs,
          fetchImpl: this.fetchImpl,
        });
        if (isSend) {
          botSendTotal.inc({ result: 'sent' });
          botSendLatencyMs.observe(this.now() - startedAt);
        }
        return result;
      } catch (error) {
        if (isSend) botSendTotal.inc({ result: sendResultOf(error) });
        if (!(error instanceof TelegramApiError) || attempt >= maxAttempts) {
          throw error;
        }
        if (error.kind === 'rate_limited') {
          const waitSec = Math.min(
            error.retryAfterSec ?? 1,
            MAX_RETRY_AFTER_SEC,
          );
          this.logger.warn(
            `Telegram 429 (${method}) — ${waitSec}s kutib qayta urinish ${attempt + 1}/${maxAttempts}`,
          );
          await this.sleep(waitSec * 1000);
          continue;
        }
        if (error.kind === 'retryable') {
          await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Xabar yuborish: 4096 belgidan uzun bo'lsa ketma-ket bo'laklarga bo'linadi
   * (klaviatura faqat oxirgisiga). callback_data 64 baytdan oshsa — throw.
   */
  async sendMessage(
    chatId: string,
    text: string,
    extra: {
      parse_mode?: TelegramParseMode;
      reply_markup?: InlineKeyboardMarkup;
      disable_web_page_preview?: boolean;
    } = {},
    options: Omit<BotCallOptions, 'chatId'> = {},
  ): Promise<unknown> {
    assertCallbackDataFits(extra.reply_markup);
    const chunks = splitMessage(text);
    let last: unknown = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      last = await this.call(
        'sendMessage',
        {
          chat_id: chatId,
          text: chunks[i],
          ...(extra.parse_mode ? { parse_mode: extra.parse_mode } : {}),
          ...(extra.disable_web_page_preview !== undefined
            ? { disable_web_page_preview: extra.disable_web_page_preview }
            : {}),
          ...(isLast && extra.reply_markup
            ? { reply_markup: extra.reply_markup }
            : {}),
        },
        { ...options, chatId },
      );
    }
    return last;
  }

  /** Spinner'ni o'chirish — eng yaxshi urinish (15 s ichida bo'lishi shart). */
  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    try {
      await this.call(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
        { maxAttempts: 1, timeoutMs: 5_000 },
      );
    } catch (error) {
      this.logger.warn(`answerCallbackQuery: ${this.describe(error)}`);
    }
  }

  getMe(): Promise<TelegramBotIdentity> {
    return this.call<TelegramBotIdentity>('getMe', {}, { maxAttempts: 1 });
  }

  getUpdates(
    offset: number,
    allowedUpdates: readonly string[],
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: allowedUpdates },
      { maxAttempts: 1, timeoutMs: 30_000 },
    );
  }

  getWebhookInfo(): Promise<{ url?: string }> {
    return this.call<{ url?: string }>(
      'getWebhookInfo',
      {},
      {
        maxAttempts: 1,
      },
    );
  }

  /**
   * (GL2GgtEc #4) Fayl yo'li. Bot API `getFile` ~20MB dan katta faylni
   * bermaydi — o'lchamni chaqiruvchi OLDIN tekshiradi (bot-media.ts).
   */
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    return this.call('getFile', { file_id: fileId }, { maxAttempts: 2 });
  }

  /**
   * (z2FRwu2c) `getFile` → fayl baytlari. Bot API ~20MB dan kattasini
   * bermaydi — chaqiruvchi o'lchamni oldin tekshiradi (bot-media.ts); bu
   * yerda ham qat'iy chegara. Token URL'da — xato matnida redaktsiya qilinadi.
   */
  async downloadFile(
    fileId: string,
    maxBytes: number = TELEGRAM_LIMITS.GET_FILE_MAX_BYTES,
  ): Promise<{ buffer: Buffer; file_path: string }> {
    const info = await this.getFile(fileId);
    const filePath = String(info?.file_path ?? '');
    if (!filePath) {
      throw new TelegramApiError('getFile', 400, 'file_path yo`q', null);
    }
    if (Number(info?.file_size) > maxBytes) {
      throw new TelegramApiError('getFile', 400, 'file is too big', null);
    }
    const token = this.defaultToken;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`,
        { method: 'GET', signal: AbortSignal.timeout(30_000) },
      );
    } catch (error) {
      throw new TelegramApiError(
        'downloadFile',
        0,
        redactToken(error instanceof Error ? error.message : 'network', token),
        null,
      );
    }
    if (!response.ok) {
      throw new TelegramApiError(
        'downloadFile',
        response.status,
        `HTTP ${response.status}`,
        null,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new TelegramApiError('downloadFile', 400, 'file is too big', null);
    }
    return { buffer, file_path: filePath };
  }

  /**
   * (DuST9k8j / BeePost extra-cost-telegram naqshi) Isbot fayllari: BITTA fayl
   * — rasm/video + izoh + tugmalar BITTA postda (`message_id` qaytadi);
   * KO'P fayl — albom (≤10), tugmalar albomga qo'yilmaydi (Telegram ruxsat
   * bermaydi) — chaqiruvchi ularni alohida xabarda yuboradi (`null`).
   */
  async sendMedia(
    chatId: string,
    files: Array<{ buffer: Buffer; mime: string; name: string }>,
    options: {
      caption?: string;
      reply_markup?: InlineKeyboardMarkup;
      parse_mode?: TelegramParseMode;
    } = {},
  ): Promise<number | null> {
    assertCallbackDataFits(options.reply_markup);
    const token = this.defaultToken;
    if (!token) {
      throw new TelegramApiError(
        'sendMedia',
        401,
        'bot token is not configured',
        null,
      );
    }
    const kindOf = (mime: string) =>
      mime.startsWith('image/')
        ? 'photo'
        : mime.startsWith('video/')
          ? 'video'
          : 'document';
    const caption = options.caption?.slice(0, CAPTION_MAX_CHARS);
    const list = files.slice(0, 10);
    await this.throttle(chatId);
    if (list.length === 1) {
      const [file] = list;
      const kind = kindOf(file.mime);
      const method =
        kind === 'photo'
          ? 'sendPhoto'
          : kind === 'video'
            ? 'sendVideo'
            : 'sendDocument';
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append(
        kind,
        new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
        file.name,
      );
      if (caption) form.append('caption', caption);
      if (options.parse_mode) form.append('parse_mode', options.parse_mode);
      if (options.reply_markup) {
        form.append('reply_markup', JSON.stringify(options.reply_markup));
      }
      const result = await callTelegramApiMultipart<{ message_id?: number }>(
        token,
        method,
        form,
        { fetchImpl: this.fetchImpl },
      );
      return result?.message_id ?? null;
    }
    const form = new FormData();
    form.append('chat_id', chatId);
    const media = list.map((file, index) => {
      const field = `file${index}`;
      form.append(
        field,
        new Blob([new Uint8Array(file.buffer)], { type: file.mime }),
        file.name,
      );
      const kind = kindOf(file.mime);
      return {
        type: kind === 'document' ? 'document' : kind,
        media: `attach://${field}`,
        ...(index === 0 && caption ? { caption } : {}),
        ...(index === 0 && caption && options.parse_mode
          ? { parse_mode: options.parse_mode }
          : {}),
      };
    });
    form.append('media', JSON.stringify(media));
    await callTelegramApiMultipart(token, 'sendMediaGroup', form, {
      fetchImpl: this.fetchImpl,
    });
    return null;
  }

  /** Xabar matni/tugmalarini tahrirlash — eng yaxshi urinish (xato loglanadi). */
  async editMessage(
    chatId: string,
    messageId: number | string,
    edit: {
      text?: string;
      reply_markup?: InlineKeyboardMarkup;
      parse_mode?: TelegramParseMode;
    },
  ): Promise<boolean> {
    assertCallbackDataFits(edit.reply_markup);
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: Number(messageId),
      reply_markup: edit.reply_markup ?? { inline_keyboard: [] },
    };
    try {
      if (edit.text !== undefined) {
        await this.call(
          'editMessageText',
          {
            ...payload,
            text: edit.text.slice(0, TELEGRAM_LIMITS.MESSAGE_MAX_CHARS),
            ...(edit.parse_mode ? { parse_mode: edit.parse_mode } : {}),
          },
          { chatId, maxAttempts: 2 },
        );
      } else {
        await this.call('editMessageReplyMarkup', payload, {
          chatId,
          maxAttempts: 2,
        });
      }
      return true;
    } catch (error) {
      // "message is not modified" — holat allaqachon shu.
      if (
        error instanceof TelegramApiError &&
        /not modified/i.test(error.description)
      ) {
        return true;
      }
      this.logger.warn(`editMessage: ${this.describe(error)}`);
      return false;
    }
  }

  describe(error: unknown): string {
    if (error instanceof TelegramApiError) return error.message;
    return redactToken(
      error instanceof Error ? error.message : String(error),
      this.envToken,
    );
  }

  private async throttle(chatId?: string): Promise<void> {
    for (;;) {
      const wait = this.globalBucket.take();
      if (wait === 0) break;
      await this.sleep(wait);
    }
    if (!chatId || !chatId.startsWith('-')) return;
    let bucket = this.groupBuckets.get(chatId);
    if (!bucket) {
      bucket = new TokenBucket(
        TELEGRAM_LIMITS.GROUP_SEND_PER_MIN,
        TELEGRAM_LIMITS.GROUP_SEND_PER_MIN / 60_000,
        () => this.now(),
      );
      this.groupBuckets.set(chatId, bucket);
    }
    for (;;) {
      const wait = bucket.take();
      if (wait === 0) return;
      await this.sleep(wait);
    }
  }
}
