import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  'sendDocument',
  'editMessageText',
  'editMessageReplyMarkup',
]);

export type TelegramErrorKind =
  | 'blocked'
  | 'rate_limited'
  | 'unauthorized'
  | 'retryable'
  | 'bad_request';

/** Bot API xatosi. `description` da token bo'lmaydi (redaktsiya qilingan). */
export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;

  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
    this.kind = classifyTelegramError(status, description);
  }
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
  if (/chat not found|bot was kicked|user is deactivated/i.test(description)) {
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
    parameters?: { retry_after?: number };
  } | null;
  if (!response.ok || !body || body.ok !== true) {
    const retryAfter = Number(body?.parameters?.retry_after);
    throw new TelegramApiError(
      method,
      response.status,
      redactToken(body?.description ?? `HTTP ${response.status}`, token),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
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
