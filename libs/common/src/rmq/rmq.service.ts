import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RmqContext,
  RmqOptions,
  RpcException,
  Transport,
} from '@nestjs/microservices';
import * as amqplib from 'amqplib';

export interface NackOptions {
  requeue?: boolean;
}

@Injectable()
export class RmqService {
  private readonly logger = new Logger(RmqService.name);

  constructor(private readonly configService: ConfigService) {}

  private getQueueNames(queueId: string): { main: string; dlq: string; dlx: string } {
    const main = this.configService.get<string>(`RABBITMQ_${queueId}_QUEUE`)!;
    return {
      main,
      dlq: `${main}_dlq`,
      dlx: `${main}_dlx`,
    };
  }

  /**
   * Idempotent DLQ topology setup. Call once on service startup before
   * connectMicroservice. Asserts: DLX (direct), DLQ (durable), and binding.
   */
  async setupDlqTopology(queueId: string): Promise<void> {
    const url = this.configService.get<string>('RABBITMQ_URI')!;
    const { main, dlq, dlx } = this.getQueueNames(queueId);
    const connection = await amqplib.connect(url);
    const channel = await connection.createChannel();
    try {
      await channel.assertExchange(dlx, 'direct', { durable: true });
      await channel.assertQueue(dlq, { durable: true });
      await channel.bindQueue(dlq, dlx, dlq);
      this.logger.log(
        `DLQ topology ready for ${queueId}: main=${main}, dlx=${dlx}, dlq=${dlq}`,
      );
    } finally {
      await channel.close();
      await connection.close();
    }
  }

  getOptions(queueId: string, noAck = false): RmqOptions {
    const ttl = Number(this.configService.get<string>('RMQ_RPC_TTL_MS') ?? 10000);
    // Per-consumer prefetch: bound how many unacked messages a single service
    // instance holds (Scale NOW-1). With prefetch UNSET (NestJS default 0 =
    // unlimited) a burst shovels unbounded messages into one Node event loop,
    // inflating per-message latency past the 5s/8s RPC timeouts and triggering
    // retry storms; a finite window turns the queue into real backpressure.
    // Money-safe: messages are still individually acked/nacked (noAck=false) and
    // every handler is idempotent (request_id + the cashbox UNIQUE dedup index),
    // so a redelivery from the bounded window can never double-post.
    const prefetch = Number(this.configService.get<string>('RMQ_PREFETCH') ?? 20);
    const { main, dlq, dlx } = this.getQueueNames(queueId);

    return {
      transport: Transport.RMQ,
      options: {
        urls: [this.configService.get<string>('RABBITMQ_URI')!],
        queue: main,
        prefetchCount: Number.isFinite(prefetch) && prefetch > 0 ? prefetch : 20,
        isGlobalPrefetchCount: false,
        queueOptions: {
          durable: true,
          messageTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 10000,
          deadLetterExchange: dlx,
          deadLetterRoutingKey: dlq,
        },
        noAck,
        persistent: true,
      },
    };
  }

  ack(context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMessage = context.getMessage();
    channel.ack(originalMessage);
  }

  /**
   * Default behavior: requeue=false → message dead-lettered to DLQ
   * (configured via deadLetterExchange in queueOptions).
   * Pass { requeue: true } for transient retries.
   */
  nack(context: RmqContext, options: NackOptions = {}) {
    const channel = context.getChannelRef();
    const originalMessage = context.getMessage();
    const requeue = options.requeue === true;
    channel.nack(originalMessage, false, requeue);
  }

  /**
   * Smart nack: chooses requeue strategy based on error type and redelivery flag.
   * - RpcException (validation / business rule) → DLQ immediately
   * - Other errors (transient): first failure → requeue once; if already redelivered → DLQ
   */
  nackForError(context: RmqContext, error: unknown) {
    const message = context.getMessage();
    const wasRedelivered = message?.fields?.redelivered === true;

    if (error instanceof RpcException) {
      this.nack(context, { requeue: false });
      return;
    }

    if (wasRedelivered) {
      this.logger.warn(
        `Message redelivered and failed again, sending to DLQ: ${(error as Error)?.message}`,
      );
      this.nack(context, { requeue: false });
      return;
    }

    this.logger.warn(
      `Transient error, requeueing for one retry: ${(error as Error)?.message}`,
    );
    this.nack(context, { requeue: true });
  }
}
