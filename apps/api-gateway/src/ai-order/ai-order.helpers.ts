import { createHash } from 'crypto';
import { GatewayTimeoutException, HttpException } from '@nestjs/common';
import { TimeoutError } from 'rxjs';
import {
  AI_VERIFY_REASON_TEXT,
  type AiVerifyFailureCode,
} from './verify-ai-orders';

/**
 * AI BUYURTMA — gateway yordamchilari (`order-gateway.controller.ts` dagi
 * `ai-parse` / `ai-confirm` uchun; PLAN C8/C10, kartalar NsxoDSmm, wgqxS0Cp,
 * bVeyEuIR). Sof funksiyalar va konstantalar — RPC chaqirmaydi.
 */

// ─────────────────────────────── Konstantalar ───────────────────────────────

/** ai-confirm: bir vaqtda ko'pi bilan shuncha buyurtma yaratiladi. */
export const AI_CONFIRM_CONCURRENCY = 3;
/**
 * ai-confirm: shu muddatgacha BOSHLANMAGAN buyurtma `not_started` bo'ladi
 * (frontend 90s va Cloudflare ~100s dan oldin javob qaytishi uchun).
 */
export const AI_CONFIRM_DEADLINE_MS = 75_000;
/**
 * Takroriy ai-confirm oynasi: order-service `order.create` ni shu muddat
 * ichida bir xil `request_id` bilan QAYTA yaratmaydi (executeIdempotent
 * `completedTtlMs`).
 */
export const AI_DEDUPE_TTL_MS = 600_000;
/**
 * `order.create` `request_id` prefiksi. ⚠️ order-service dedupe opsiyalarini
 * (TTL, reclaimFailed, markReplay) FAQAT shu prefiksli so'rovga qo'llaydi —
 * oddiy `POST /orders` xulqi o'zgarmaydi.
 */
export const AI_DEDUPE_PREFIX = 'ai-dedupe:';
/** ai-parse: `order.ai_resolve_preview` RPC shifti. */
export const AI_RESOLVE_TIMEOUT_MS = 25_000;
/** ai-parse: umumiy byudjet — extract 60s + preview ≤25s (< frontend 90s). */
export const AI_PARSE_TOTAL_BUDGET_MS = 85_000;

// ─────────────────────────────── ai-parse sabablari ─────────────────────────

/**
 * Frontendga chiqadigan sabablar (PLAN 5.5). `invalid_json` va noma'lum
 * sabablar `ai_error` ga aylanadi; `ai_off` / `insufficient` HECH QACHON
 * chiqmaydi.
 */
export type AiParseFailureReason =
  | 'disabled'
  | 'refused'
  | 'truncated'
  | 'network'
  | 'ai_error'
  | 'no_market'
  | 'cap_exceeded';

export interface AiParseFailure {
  ok: false;
  reason: AiParseFailureReason;
  /** Odam o'qiydigan o'zbekcha izoh (UI o'z matnini ishlatishi mumkin). */
  message: string;
  /** Faqat `cap_exceeded` da. */
  scope?: 'global';
  /** Faqat `cap_exceeded` da — shift qachon yangilanadi (ISO). */
  reset_at?: string;
}

/** Har sabab uchun ALOHIDA matn (NsxoDSmm #11, bVeyEuIR #9). */
export const AI_PARSE_REASON_MESSAGES: Readonly<
  Record<AiParseFailureReason, string>
> = Object.freeze({
  truncated: 'Matn juda katta — 10 tadan qismlarga bo‘lib yuboring',
  network: 'AI javob bermadi — qayta urinib ko‘ring',
  ai_error: 'AI javob bermadi — qayta urinib ko‘ring',
  disabled: 'AI hozir o‘chiq — qo‘lda kiriting',
  refused: 'AI bu matnni qayta ishlamadi — qo‘lda kiriting',
  cap_exceeded: 'AI kunlik limiti tugadi — qo‘lda kiriting',
  no_market: 'Operator hech qaysi marketga biriktirilmagan',
});

const PARSE_REASONS = new Set<string>(Object.keys(AI_PARSE_REASON_MESSAGES));

/**
 * ai-service / gateway sababidan frontend javobi:
 * `{ok:false, reason, message, scope?, reset_at?}`.
 * `invalid_json` → `ai_error`; noma'lum sabab → `ai_error`;
 * `cap_exceeded` ning `scope`/`reset_at` saqlanadi (boshqalarda tashlanadi).
 */
export function toParseFailure(
  r:
    | { reason?: unknown; scope?: unknown; reset_at?: unknown }
    | null
    | undefined,
): AiParseFailure {
  const raw = typeof r?.reason === 'string' ? r.reason : '';
  const reason: AiParseFailureReason = PARSE_REASONS.has(raw)
    ? (raw as AiParseFailureReason)
    : 'ai_error';
  const failure: AiParseFailure = {
    ok: false,
    reason,
    message: AI_PARSE_REASON_MESSAGES[reason],
  };
  if (reason === 'cap_exceeded') {
    if (r?.scope === 'global') failure.scope = 'global';
    if (typeof r?.reset_at === 'string' && r.reset_at.trim()) {
      failure.reset_at = r.reset_at;
    }
  }
  return failure;
}

// ─────────────────────────────── ai-confirm sabablari ───────────────────────

/**
 * ai-confirm natijasining mashina kaliti (PLAN C10).
 * `timeout_unknown` — "natija noma'lum" (timeout YOKI servisning noma'lum
 * xatosi, `toConfirmFailure` ga qarang).
 */
export type AiConfirmFailureCode =
  | AiVerifyFailureCode
  | 'duplicate_in_batch'
  | 'duplicate_recent'
  | 'duplicate_in_progress'
  | 'validation_unavailable'
  | 'create_failed'
  | 'timeout_unknown'
  | 'not_started';

/**
 * Har kod uchun odam o'qiydigan o'zbekcha sabab — frontend `reason` ni
 * o'zgartirmasdan ko'rsatadi.
 */
export const AI_CONFIRM_REASON_TEXT: Readonly<
  Record<AiConfirmFailureCode, string>
> = Object.freeze({
  ...AI_VERIFY_REASON_TEXT,
  duplicate_in_batch:
    'Bu buyurtma ro‘yxatda takrorlangan — faqat bir marta yaratiladi',
  duplicate_recent:
    'Bu buyurtma 10 daqiqa ichida allaqachon yaratilgan — takror yaratilmadi',
  duplicate_in_progress:
    'Xuddi shu buyurtma hozir yaratilmoqda — “Yangi buyurtmalar”ni tekshiring, qayta yubormang',
  validation_unavailable:
    'Tuman va mahsulotlarni tekshirib bo‘lmadi — buyurtma yaratilmadi, birozdan so‘ng qayta yuboring',
  create_failed: 'Buyurtma yaratilmadi',
  timeout_unknown:
    'Natija noma’lum — buyurtma yaratilgan bo‘lishi mumkin. “Yangi buyurtmalar”ni tekshiring, qayta yubormang',
  not_started: 'Vaqt yetmadi — bu buyurtma yaratilmadi, uni qayta yuboring',
});

/** Tashqariga chiqadigan xato matnining eng katta uzunligi. */
const CONFIRM_MESSAGE_MAX_CHARS = 300;
/** identity: `Bu telefon raqam boshqa rolda allaqachon mavjud` (409). */
const PHONE_CONFLICT_RE = /telefon/i;
/**
 * Nest `BaseRpcExceptionFilter.handleUnknownError` matni
 * (`@nestjs/core` `MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`).
 */
const NEST_UNKNOWN_RPC_MESSAGE = 'Internal server error';

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof GatewayTimeoutException ||
    error instanceof TimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

/** HttpException yoki RPC xato obyektidan status kodi. */
function statusOf(error: unknown): number | null {
  if (error instanceof HttpException) return error.getStatus();
  if (!error || typeof error !== 'object') return null;
  const obj = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { statusCode?: unknown } | null;
  };
  const candidates = [obj.statusCode, obj.status, obj.response?.statusCode];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('. ');
  }
  return '';
}

/**
 * Xatodan FAQAT xabar satri (AllExceptionsFilter bilan bir xil manbalar).
 * Payload, `data`, stack HECH QACHON olinmaydi.
 */
function messageOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response.trim();
    const fromBody = messageText(
      (response as { message?: unknown } | null)?.message,
    );
    return fromBody || messageText(error.message);
  }
  if (error && typeof error === 'object') {
    const obj = error as {
      message?: unknown;
      response?: { message?: unknown } | null;
    };
    return messageText(obj.message) || messageText(obj.response?.message);
  }
  return typeof error === 'string' ? error.trim() : '';
}

/**
 * RMQ orqali qaytgan "noma'lum" xato: servis handler'i `RpcException` EMAS,
 * oddiy `Error` tashlaganda Nest asl xabarni YASHIRADI va faqat
 * `{status:'error', message:'Internal server error'}` yuboradi (raqamli status
 * yo'q; `Error` nusxasi emas — JSON'dan tiklangan oddiy obyekt).
 *
 * ⚠️ `order.create` (`ai-dedupe:` kaliti) uchun bu NATIJA NOMA'LUM degani,
 * "yaratilmadi" EMAS:
 *  - handler oddiy xato bilan yiqilsa `nackForError` xabarni bir marta qayta
 *    navbatga qo'yadi, `reclaimFailed` esa yaratishni QAYTA ishga tushiradi —
 *    buyurtma gateway javob bergandan KEYIN yaratilishi mumkin;
 *  - executeIdempotent `in_progress` ni `markReplay` siz (oddiy `Error`)
 *    tashlasa ham shu shakl keladi. `ai-dedupe:` kaliti `markReplay` bilan
 *    ishlaydi — u yerda `in_progress` `RpcException({statusCode:409})`
 *    bo'lib matni bilan keladi va `duplicate_in_progress` ga aylanadi.
 * `RpcException('matn')` (`{status:'error', message:'<matn>'}`) — ataylab
 * tashlangan biznes xatosi, u bu yerga TUSHMAYDI (matn boshqa).
 */
function isUnknownRemoteError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || error instanceof Error) {
    return false;
  }
  const obj = error as { status?: unknown; message?: unknown };
  return (
    obj.status === 'error' &&
    statusOf(error) === null &&
    messageText(obj.message) === NEST_UNKNOWN_RPC_MESSAGE
  );
}

function clip(text: string): string {
  return text.length > CONFIRM_MESSAGE_MAX_CHARS
    ? `${text.slice(0, CONFIRM_MESSAGE_MAX_CHARS - 1)}…`
    : text;
}

/**
 * Bitta buyurtmani yaratishdagi xato → `{code, reason}`.
 *
 * ⚠️ Timeout — `timeout_unknown`: order.create ketgan bo'lishi mumkin, ya'ni
 * buyurtma YARATILGAN bo'lishi mumkin — operatorga qayta yubormaslik aytiladi
 * (qayta yuborish baribir ai-dedupe bilan to'siladi).
 * ⚠️ `duplicate_in_progress` — xabarda `Idempotency in_progress` bo'lsa.
 * order-service (`ai-dedupe:` kaliti, executeIdempotent `markReplay`) uni
 * nack(requeue) dan keyin `RpcException({statusCode:409, message})` sifatida
 * tashlaydi; RMQ'dan `{statusCode:409, message:'Idempotency in_progress …'}`
 * bo'lib keladi. Tekshiruv umumiy 409 (telefon) va noma'lum-xato
 * tarmoqlaridan OLDIN turadi. Nest'ning noma'lum-xato javobi
 * (`isUnknownRemoteError`, oddiy `Error`) esa `timeout_unknown`: undan asl
 * sababni ajratib bo'lmaydi va buyurtma yaratilgan/yaratilayotgan bo'lishi
 * mumkin — "Buyurtma yaratilmadi" deyish operatorni qo'lda qayta kiritishga
 * (haqiqiy dublikatga) undaydi.
 * ⚠️ Xom payload (mijoz ma'lumoti, dto) HECH QACHON javobga chiqmaydi — faqat
 * 400 xabari va identity'ning telefon-boshqa-rolda (409) matni o'tkaziladi.
 */
export function toConfirmFailure(error: unknown): {
  code: AiConfirmFailureCode;
  reason: string;
} {
  if (isTimeoutError(error)) {
    return {
      code: 'timeout_unknown',
      reason: AI_CONFIRM_REASON_TEXT.timeout_unknown,
    };
  }

  const message = messageOf(error);
  if (message.includes('Idempotency in_progress')) {
    return {
      code: 'duplicate_in_progress',
      reason: AI_CONFIRM_REASON_TEXT.duplicate_in_progress,
    };
  }

  if (isUnknownRemoteError(error)) {
    return {
      code: 'timeout_unknown',
      reason: AI_CONFIRM_REASON_TEXT.timeout_unknown,
    };
  }

  const status = statusOf(error);
  if (status === 409 && message && PHONE_CONFLICT_RE.test(message)) {
    return { code: 'create_failed', reason: clip(message) };
  }
  if (status === 400 && message) {
    return { code: 'create_failed', reason: clip(message) };
  }

  return {
    code: 'create_failed',
    reason: AI_CONFIRM_REASON_TEXT.create_failed,
  };
}

// ─────────────────────────────── Dublikat imzosi ────────────────────────────

/** Imzo uchun minimal buyurtma shakli (`AiConfirmOrderDto` unga mos). */
export interface AiSignatureOrderInput {
  customer?: { phone_number?: unknown } | null;
  district_id?: unknown;
  total_price?: unknown;
  where_deliver?: unknown;
  items?: ReadonlyArray<
    | { product_id?: unknown; product_name?: unknown; quantity?: unknown }
    | null
    | undefined
  > | null;
}

/**
 * Massiv bo'lsa o'zi, aks holda bo'sh massiv. (`Array.isArray` readonly
 * massivni `any[]` ga toraytirib yuboradi — tip shu yerda qaytariladi.)
 */
function listOf<T>(
  value: ReadonlyArray<T> | null | undefined,
): ReadonlyArray<T> {
  return Array.isArray(value) ? (value as ReadonlyArray<T>) : [];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministik dublikat imzosi (PLAN 5.18) — sha256 hex:
 * `[marketId, phone, district_id, round(total_price), where_deliver,
 *   ...saralangan itemlar].join('|')`, item — `p<id>x<q>` yoki
 * `n<nom (kichik harf)>x<q>`.
 *
 * Ism, izoh, manzil, operator imzoga KIRMAYDI: bir xil telefon + tuman + narx
 * + mahsulotlar — bir xil buyurtma. Itemlar tartibi ahamiyatsiz.
 */
export function aiOrderSignature(
  marketId: string,
  order: AiSignatureOrderInput,
): string {
  const items = listOf(order?.items)
    .map((item) => {
      const quantity = textOf(item?.quantity);
      const productId = textOf(item?.product_id);
      return productId
        ? `p${productId}x${quantity}`
        : `n${textOf(item?.product_name).toLowerCase()}x${quantity}`;
    })
    .sort(compareText);
  const price = Number(order?.total_price);
  const parts = [
    textOf(marketId),
    textOf(order?.customer?.phone_number),
    textOf(order?.district_id),
    String(Math.round(Number.isFinite(price) ? price : 0)),
    textOf(order?.where_deliver).toLowerCase(),
    ...items,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

// ─────────────────────────────── Yo'laklar (lanes) ──────────────────────────

export type LaneOutcome<R> =
  | { status: 'done'; value: R }
  | { status: 'error'; error: unknown }
  | { status: 'not_started' };

/**
 * Cheklangan parallellik bilan ishlatish (ai-confirm, PLAN 5.18):
 *  - bir vaqtda ko'pi bilan `concurrency` ta ish;
 *  - bir xil `laneKey` li ishlar QAT'IY ketma-ket (kirish tartibida) — bitta
 *    telefon uchun ikki buyurtma bir vaqtda yaratilmaydi (identity customer
 *    yaratish poygasi bo'lmaydi);
 *  - `deadlineAt` (epoch ms) gacha BOSHLANMAGAN ish — `not_started`
 *    (boshlangan ish uzilmaydi);
 *  - har ish o'z try/catch'i bilan — biri yiqilsa qolganlari davom etadi;
 *  - natijalar KIRISH tartibida.
 */
export async function runInLanes<T, R>(
  items: ReadonlyArray<T>,
  laneKey: (item: T, index: number) => string,
  concurrency: number,
  deadlineAt: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<LaneOutcome<R>>> {
  const list = listOf(items);
  const results = list.map((): LaneOutcome<R> => ({ status: 'not_started' }));

  // Yo'laklar birinchi uchragan tartibda; bo'sh kalit — alohida yo'lak.
  const lanes: number[][] = [];
  const laneByKey = new Map<string, number[]>();
  list.forEach((item, index) => {
    let key = '';
    try {
      key = String(laneKey(item, index) ?? '');
    } catch {
      key = '';
    }
    const existing = key ? laneByKey.get(key) : undefined;
    if (existing) {
      existing.push(index);
      return;
    }
    const lane = [index];
    lanes.push(lane);
    if (key) laneByKey.set(key, lane);
  });

  let nextLane = 0;
  const runSlot = async (): Promise<void> => {
    while (nextLane < lanes.length) {
      const lane = lanes[nextLane++];
      for (const index of lane) {
        if (Date.now() >= deadlineAt) {
          results[index] = { status: 'not_started' };
          continue;
        }
        try {
          results[index] = {
            status: 'done',
            value: await worker(list[index], index),
          };
        } catch (error: unknown) {
          results[index] = { status: 'error', error };
        }
      }
    }
  };

  const slots = Math.min(
    lanes.length,
    Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1,
  );
  await Promise.all(Array.from({ length: slots }, () => runSlot()));
  return results;
}
