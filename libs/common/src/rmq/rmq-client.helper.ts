import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout, retry, timer, throwError } from 'rxjs';

export const RMQ_GATEWAY_TIMEOUT = 8000;
export const RMQ_SERVICE_TIMEOUT = 5000;
export const RMQ_FIRE_AND_FORGET_TIMEOUT = 1500;

export interface RmqSendOptions {
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
}

/**
 * Wrapper around firstValueFrom with timeout and retry (exponential backoff).
 * Only retries on timeout errors; RpcExceptions are thrown immediately.
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

  return firstValueFrom(
    client.send<T>(pattern, data).pipe(
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
