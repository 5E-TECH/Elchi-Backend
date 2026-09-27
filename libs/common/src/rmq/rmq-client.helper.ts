import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout, retry, timer, throwError } from 'rxjs';
import { randomUUID } from 'crypto';
import { requestContext } from '../context/request-context';

export const RMQ_GATEWAY_TIMEOUT = 8000;
export const RMQ_SERVICE_TIMEOUT = 5000;
export const RMQ_FIRE_AND_FORGET_TIMEOUT = 1500;

export interface RmqSendOptions {
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  /** Set false to skip auto-injecting request_id (e.g. for read-only queries). Default: true. */
  attachRequestId?: boolean;
}

/**
 * AI (Anthropic) RPC shifti. Butun vaqt zanjiri — har bir bo'g'in o'zidan
 * keyingisidan QISQA bo'lishi SHART, aks holda tashqi qatlam ichkisidan oldin
 * uziladi va foydalanuvchi aniq sabab o'rniga 504 ko'radi:
 *
 *   Anthropic SDK 55s (ANTHROPIC_TIMEOUT_MS, maxRetries 0)
 *     < RPC 60s (shu qiymat; gateway `.pipe(timeout(AI_RPC_TIMEOUT_MS))`)
 *     < frontend 90s (Elchi-Frontend `AI_REQUEST_TIMEOUT_MS`, axios)
 *     < Cloudflare ~100s.
 *
 * Gateway'da ai-parse'ning umumiy byudjeti: extract 60s + preview ≤25s = 85s
 * (< 90s).
 *
 * ⚠️ `RMQ_SERVICE_TIMEOUT` (5s) va `rmqSend` ning sukutdagi `retries ?? 2` si
 * O'ZGARTIRILMAYDI — boshqa barcha RPC'lar o'sha qiymatlarda qoladi. AI
 * chaqiruvlari shu konstantalarni ANIQ uzatadi.
 *
 * ⚠️ `RMQ_RPC_TTL_MS` ga (navbatdagi KUTISH muddati, rmq.service.ts) TEGILMAYDI —
 * bu infratuzilma o'zgarishi (2026-09-14 hodisasi). p95 60s dan oshsa yechim
 * asinxron job, TTL/timeout'ni cho'zish EMAS.
 */
export const AI_RPC_TIMEOUT_MS = 60_000;

/**
 * Servis→servis `ai.*` chaqiruvlari uchun `rmqSend` opsiyalari.
 *
 * ⚠️ `retries: 0` — MAJBURIY. `rmqSend` timeout'da qayta yuboradi (sukut 2),
 * lekin AI chaqiruvi bekor qilinmaydi: kechikkan birinchi so'rov ai-service'da
 * baribir bajariladi va har bir qayta urinish Anthropic'ni YANA chaqiradi — pul
 * ikki-uch marta yechiladi. Qisqa muddat kerak bo'lsa `timeoutMs` ni almashtiring,
 * `retries` ni emas: `{ ...AI_RPC_SEND_OPTIONS, timeoutMs: x }`.
 * `ai-rpc-no-retry.guard.spec.ts` buni statik tekshiradi.
 *
 * Muzlatilgan (`Object.freeze`) — umumiy konstantani tasodifan o'zgartirib
 * qo'yish boshqa chaqiruvlarning xulqini jimgina buzardi.
 */
export const AI_RPC_SEND_OPTIONS: RmqSendOptions = Object.freeze({
  timeoutMs: AI_RPC_TIMEOUT_MS,
  retries: 0,
});

/**
 * `deadline_at` gacha kamida shuncha vaqt qolmagan bo'lsa AI chaqirilmaydi:
 * xabar navbatda eskirgan, gateway javobni baribir kutmaydi — Anthropic'ga
 * borish faqat pul sarflaydi. Bunday holatda handler `{ok:false,
 * reason:'network'}` qaytaradi.
 */
export const AI_MIN_BUDGET_MS = 10_000;

/**
 * Auto-inject `request_id` (idempotency, per-call) and `trace_id` (correlation,
 * per-HTTP-request) into the outgoing payload. Server-side handlers use
 * `request_id` for IdempotencyService dedup and `trace_id` to bind logs to
 * the originating HTTP request. Caller-provided values are preserved.
 */
function withRequestId<T>(data: T): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  const enriched: Record<string, unknown> = { ...obj };
  if (typeof obj.request_id !== 'string' || obj.request_id.length === 0) {
    enriched.request_id = randomUUID();
  }
  if (typeof obj.trace_id !== 'string' || obj.trace_id.length === 0) {
    const ctxTraceId = requestContext.getTraceId();
    if (ctxTraceId) {
      enriched.trace_id = ctxTraceId;
    }
  }
  return enriched as T;
}

/**
 * Wrapper around firstValueFrom with timeout and retry (exponential backoff).
 * Only retries on timeout errors; RpcExceptions are thrown immediately.
 * Auto-attaches request_id to the payload for idempotency on the server side.
 */
export async function rmqSend<T = unknown>(
  client: ClientProxy,
  pattern: { cmd: string },
  data: unknown,
  options?: RmqSendOptions,
): Promise<T> {
  const ms = options?.timeoutMs ?? RMQ_SERVICE_TIMEOUT;
  const maxRetries = options?.retries ?? 2;
  const baseDelay = options?.retryBaseDelayMs ?? 200;
  const payload =
    options?.attachRequestId === false ? data : withRequestId(data);

  return firstValueFrom(
    client.send<T>(pattern, payload).pipe(
      timeout(ms),
      retry({
        count: maxRetries,
        delay: (error, retryCount) => {
          if (error instanceof RpcException) {
            return throwError(() => error);
          }
          const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1), 2000);
          return timer(delay);
        },
      }),
    ),
  );
}
