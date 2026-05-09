import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout, retry, timer, throwError } from 'rxjs';
import { randomUUID } from 'crypto';

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
 * Auto-inject request_id into the payload so server-side handlers can
 * deduplicate retries via IdempotencyService. Caller-provided request_id is
 * preserved. Non-object payloads (strings, primitives) are passed through.
 */
function withRequestId<T>(data: T): T {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.request_id === 'string' && obj.request_id.length > 0) {
    return data;
  }
  return { ...obj, request_id: randomUUID() } as T;
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
