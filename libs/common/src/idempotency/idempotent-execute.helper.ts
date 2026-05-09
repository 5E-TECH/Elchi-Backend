import { RmqContext, RpcException } from '@nestjs/microservices';
import { RmqService } from '../rmq/rmq.service';
import { executeAndAck } from '../rmq/execute-and-ack.helper';
import { IdempotencyService } from './idempotency.service';

export interface IdempotentExecuteOptions {
  /** Unique request identifier from the caller (gateway). If absent, fallback to plain executeAndAck. */
  requestId?: string;
  /** Pattern for indexing/diagnostics, e.g. 'order.create'. */
  pattern: string;
  /** Optional namespace prefix to keep keys unique across services if needed. */
  keyPrefix?: string;
}

/**
 * Idempotent message handler. If a request_id is present in the payload, the
 * key (pattern + request_id) is used to deduplicate work:
 *   - first call → handler runs, response cached
 *   - duplicate call (any future delivery) → cached response returned, no re-run
 *   - duplicate while first call is still running → message requeued (will retry shortly)
 *
 * Without a request_id this delegates to executeAndAck (no idempotency).
 */
export async function executeIdempotent<T>(
  rmqService: RmqService,
  idempotencyService: IdempotencyService,
  context: RmqContext,
  options: IdempotentExecuteOptions,
  handler: () => Promise<T> | T,
): Promise<T> {
  const { requestId, pattern, keyPrefix } = options;

  if (!requestId) {
    return executeAndAck(rmqService, context, handler);
  }

  const key = `${keyPrefix ?? pattern}:${requestId}`;
  const acquire = await idempotencyService.tryAcquire<T>(key, pattern);

  if (acquire.status === 'cached') {
    rmqService.ack(context);
    return acquire.response;
  }

  if (acquire.status === 'failed') {
    rmqService.ack(context);
    throw new RpcException(acquire.error as object);
  }

  if (acquire.status === 'in_progress') {
    rmqService.nack(context, { requeue: true });
    throw new Error(`Idempotency in_progress for ${key}, message requeued`);
  }

  try {
    const result = await handler();
    await idempotencyService.markCompleted(key, result);
    rmqService.ack(context);
    return result;
  } catch (handlerError) {
    const errorPayload =
      handlerError instanceof RpcException
        ? handlerError.getError()
        : { message: (handlerError as Error)?.message ?? 'unknown error' };
    await idempotencyService.markFailed(key, errorPayload);
    rmqService.nackForError(context, handlerError);
    throw handlerError;
  }
}
