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
  const payload = options?.attachRequestId === false ? data : withRequestId(data);

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
