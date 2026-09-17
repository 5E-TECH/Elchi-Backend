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
              const ttl = Number(
                configService.get<string>('RMQ_RPC_TTL_MS') ?? 60000,
              );
              return {
                transport: Transport.RMQ,
                options: {
                  urls: [configService.get<string>('RABBITMQ_URI')!],
                  queue: configService.get<string>(`RABBITMQ_${name}_QUEUE`)!,
                  noAssert: true,
                  /**
                   * ⚠️ TCP_NODELAY — HAR BIR CHAQIRUVDAN ~43 ms OLIB TASHLAYDI.
                   *
                   * Produksiyada o'lchandi (xom amqplib, so'rov→javob):
                   *     noDelay O'CHIQ : 45,4 ms
                   *     noDelay YOQIQ  :  2,6 ms
                   *
                   * Sabab — Nagle algoritmi + delayed ACK: AMQP kadri kichik
                   * bo'lgani uchun yadro uni yuborishdan oldin "yana ma'lumot
                   * keladimi" deb ~40 ms kutadi. Bu kechikish HAR BIR RMQ
                   * borib-kelishiga tushadi, ya'ni bitta sotuvda 5–9 marta
                   * to'lanadi va outbox'ning ketma-ket nashrida har hodisaga
                   * qayta takrorlanadi.
                   *
                   * Xavfi yo'q: Nagle faqat kichik paketlarni BIRLASHTIRISH
                   * uchun, ishonchlilikka aloqasi yo'q. RPC naqshida esa
                   * birlashtiradigan narsa yo'q — har so'rov mustaqil.
                   */
                  socketOptions: {
                    connectionOptions: { noDelay: true },
                  },
                  queueOptions: {
                    durable: true,
                    messageTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 60000,
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
