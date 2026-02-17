import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RmqContext, RmqOptions, Transport } from '@nestjs/microservices';

@Injectable()
export class RmqService {
  constructor(private readonly configService: ConfigService) {}

  getOptions(queue: string, noAck = false): RmqOptions {
    const ttl = Number(this.configService.get<string>('RMQ_RPC_TTL_MS') ?? 10000);

    return {
      transport: Transport.RMQ,
      options: {
        urls: [this.configService.get<string>('RABBITMQ_URI')!],
        queue: this.configService.get<string>(`RABBITMQ_${queue}_QUEUE`)!,
        queueOptions: {
          durable: true,
          messageTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 10000,
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
}
