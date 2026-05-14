import { RmqContext } from '@nestjs/microservices';
import { RmqService } from './rmq.service';
import { captureException } from '../sentry/sentry.helper';

/**
 * Wrap a message handler to automatically ack on success and smart-nack on
 * error. Smart-nack: RpcException → DLQ; transient → requeue once → DLQ.
 * Unexpected errors (non-RpcException, 5xx-shaped) are forwarded to Sentry.
 */
export async function executeAndAck<T>(
  rmqService: RmqService,
  context: RmqContext,
  handler: () => Promise<T> | T,
): Promise<T> {
  try {
    const result = await handler();
    rmqService.ack(context);
    return result;
  } catch (error) {
    captureException(error, {
      rmq_pattern: context.getPattern?.() ?? 'unknown',
    });
    rmqService.nackForError(context, error);
    throw error;
  }
}
