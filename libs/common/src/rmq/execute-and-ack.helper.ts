import { RmqContext } from '@nestjs/microservices';
import { RmqService } from './rmq.service';

/**
 * Wrap a message handler to automatically ack on success and smart-nack on
 * error. Smart-nack: RpcException → DLQ; transient → requeue once → DLQ.
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
    rmqService.nackForError(context, error);
    throw error;
  }
}
