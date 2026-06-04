import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { RealtimeGateway } from './realtime.gateway';

interface RealtimeNotifyPayload {
  event: string;
  payload?: unknown;
  user_id?: string | null;
  role?: string | null;
  broadcast?: boolean;
}

/**
 * RMQ bridge for server → client push. Any service emits
 * `client.emit({ cmd: 'realtime.notify' }, payload)` to the gateway queue and
 * the connected socket.io clients receive it. Event-based (fire-and-forget):
 * a missing/offline recipient is simply a no-op, never an error to the caller.
 */
@Controller()
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);

  constructor(private readonly realtime: RealtimeGateway) {}

  @EventPattern({ cmd: 'realtime.notify' })
  notify(
    @Payload() data: RealtimeNotifyPayload,
    @Ctx() context: RmqContext,
  ): void {
    try {
      const event = String(data?.event ?? '').trim();
      if (event) {
        if (data.user_id) {
          this.realtime.pushToUser(String(data.user_id), event, data.payload);
        }
        if (data.role) {
          this.realtime.pushToRole(String(data.role), event, data.payload);
        }
        if (data.broadcast) {
          this.realtime.broadcast(event, data.payload);
        }
      }
    } catch (err) {
      this.logger.error(
        `realtime.notify failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      // Ack the event so it isn't redelivered — delivery to sockets is
      // best-effort and must not block the broker.
      const channel = context.getChannelRef() as {
        ack: (msg: unknown) => void;
      };
      channel.ack(context.getMessage());
    }
  }
}
