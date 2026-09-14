import { RmqService } from './rmq.service';

/**
 * ⚠️ 2026-09-14 — PRODUKSIYA TO'LIQ TO'XTAGAN HODISA.
 *
 * `RMQ_RPC_TTL_MS` sukuti 10 000 dan 60 000 ga o'zgartirildi. RabbitMQ
 * MAVJUD navbatning argumentini o'zgartirishga ruxsat bermaydi:
 * `PRECONDITION_FAILED: inequivalent arg 'x-message-ttl'`. Xato KANAL
 * darajasida yuzaga keladi va servis jurnaliga tushmaydi — natijada 14 ta
 * konteyner ham "Up" ko'rinadi, birortasida iste'molchi yo'q, har bir
 * so'rov 504 bilan tugaydi.
 *
 * Bu testlar ikkita narsani qulflaydi:
 *   1. TTL BITTA joyda hal qilinadi — transport va startdagi tekshiruv
 *      jimgina ajralib ketmasin;
 *   2. navbat argumentlari `getOptions` bilan aynan bir xil bo'lsin.
 */
describe('RmqService — navbat argumentlari bitta manbadan', () => {
  function makeService(env: Record<string, string> = {}) {
    const configService = {
      get: (key: string) => env[key],
    } as unknown as ConstructorParameters<typeof RmqService>[0];
    return new RmqService(configService);
  }

  const baseEnv = {
    RABBITMQ_URI: 'amqp://guest:guest@localhost:5672',
    RABBITMQ_ORDER_QUEUE: 'order_queue',
  };

  it('transport va tekshiruv AYNI TTL ni ishlatadi', () => {
    const service = makeService(baseEnv);
    const options = service.getOptions('ORDER') as {
      options: { queueOptions: { messageTtl: number } };
    };
    const args = (
      service as unknown as {
        mainQueueArguments: (id: string) => { messageTtl: number };
      }
    ).mainQueueArguments('ORDER');

    expect(options.options.queueOptions.messageTtl).toBe(args.messageTtl);
  });

  it('sukut TTL — 60 s (audit C5)', () => {
    const service = makeService(baseEnv);
    const ttl = (
      service as unknown as { resolveTtlMs: () => number }
    ).resolveTtlMs();
    expect(ttl).toBe(60000);
  });

  it('env qiymati ustun turadi', () => {
    const service = makeService({ ...baseEnv, RMQ_RPC_TTL_MS: '15000' });
    const options = service.getOptions('ORDER') as {
      options: { queueOptions: { messageTtl: number } };
    };
    expect(options.options.queueOptions.messageTtl).toBe(15000);
  });

  it('yaroqsiz env qiymatida sukutga qaytadi', () => {
    const service = makeService({ ...baseEnv, RMQ_RPC_TTL_MS: 'abc' });
    const ttl = (
      service as unknown as { resolveTtlMs: () => number }
    ).resolveTtlMs();
    expect(ttl).toBe(60000);
  });

  /**
   * ⚠️ TCP_NODELAY — PRODUKSIYADA O'LCHANGAN ENG KATTA YUTUQ.
   *
   * Xom amqplib bilan so'rov→javob borib-kelishi o'lchandi:
   *     noDelay o'chiq : 45,4 ms
   *     noDelay yoqiq  :  2,6 ms   (17×)
   *
   * Sabab — Nagle algoritmi + delayed ACK: AMQP kadri kichik bo'lgani uchun
   * yadro uni ~40 ms ushlab turadi. Bu kechikish HAR BIR RMQ borib-kelishiga
   * tushadi: bitta sotuvda 5–9 marta, outbox'ning ketma-ket nashrida esa har
   * hodisaga qayta.
   *
   * Test shu sozlamani qulflaydi — u tasodifan olib tashlansa, butun tizim
   * jimgina 17 barobar sekinlashadi va buni faqat o'lchov ko'rsatadi.
   */
  it('TCP_NODELAY yoqilgan (server tomoni)', () => {
    const service = makeService(baseEnv);
    const options = service.getOptions('ORDER') as {
      options: {
        socketOptions?: { connectionOptions?: { noDelay?: boolean } };
      };
    };
    expect(options.options.socketOptions?.connectionOptions?.noDelay).toBe(
      true,
    );
  });

  it('DLX/DLQ nomlari transport bilan mos', () => {
    const service = makeService(baseEnv);
    const options = service.getOptions('ORDER') as {
      options: {
        queueOptions: {
          deadLetterExchange: string;
          deadLetterRoutingKey: string;
        };
      };
    };
    const args = (
      service as unknown as {
        mainQueueArguments: (id: string) => {
          deadLetterExchange: string;
          deadLetterRoutingKey: string;
        };
      }
    ).mainQueueArguments('ORDER');

    expect(args.deadLetterExchange).toBe(
      options.options.queueOptions.deadLetterExchange,
    );
    expect(args.deadLetterRoutingKey).toBe(
      options.options.queueOptions.deadLetterRoutingKey,
    );
    expect(args.deadLetterExchange).toBe('order_queue_dlx');
    expect(args.deadLetterRoutingKey).toBe('order_queue_dlq');
  });
});
