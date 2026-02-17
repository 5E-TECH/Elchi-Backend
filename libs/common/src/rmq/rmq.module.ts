import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RmqService } from './rmq.service';

interface RmqModuleOptions {
  name: string;
}

@Module({
  providers: [RmqService],
  exports: [RmqService],
})
export class RmqModule {
  static register({ name }: RmqModuleOptions): DynamicModule {
    return {
      module: RmqModule,
      imports: [
        ClientsModule.registerAsync([
          {
            name,
            useFactory: (configService: ConfigService) => {
              const ttl = Number(configService.get<string>('RMQ_RPC_TTL_MS') ?? 10000);
              return {
                transport: Transport.RMQ,
                options: {
                  urls: [configService.get<string>('RABBITMQ_URI')!],
                  queue: configService.get<string>(`RABBITMQ_${name}_QUEUE`)!,
                  queueOptions: {
                    durable: true,
                    messageTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 10000,
                  },
                },
              };
            },
            inject: [ConfigService],
          },
        ]),
      ],
      exports: [ClientsModule],
    };
  }
}
