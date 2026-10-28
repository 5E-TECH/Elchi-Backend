import { RmqOptions, Transport } from '@nestjs/microservices';
import * as amqplib from 'amqplib';

/**
 * Gateway'ning o'z RMQ iste'molchisi (`RABBITMQ_GATEWAY_QUEUE`): servislar
 * `realtime.notify` / `auth.sessions.kick` / `realtime.presence.check`
 * yuboradi, `RealtimeController` socket.io'ga uzatadi (main.ts — hybrid).
 *
 * ⚠️ `noAck: false` (rWdLuoP3, 2026-10-25). `RealtimeController` ning UCHALA
 * handleri xabarni O'ZI tasdiqlaydi (`channel.ack` — `finally` da). Nest
 * sukuti `noAck: true` bilan broker xabarni allaqachon avtomatik tasdiqlagan,
 * qo'lda ack esa 406 PRECONDITION_FAILED («unknown delivery tag») bilan
 * KANALNI YOPARDI: har realtime xabardan keyin iste'molchi ~5 s qayta ulanardi
 * va shu oraliqdagi keyingi hodisa (masalan, bildirishnomadan keyin kelgan
 * smena hodisasi) ~5 s kechikardi. Lokal RabbitMQ'da o'lchangan: ketma-ket
 * ikkinchi hodisa 5,0 s → 0,9 s. Navbat parametrlari (`noAssert`, `durable`)
 * o'zgarmagan — mavjud navbat qayta e'lon qilinmaydi. Navbat YO'Q bo'lsa
 * (yangi RabbitMQ) uni `ensureGatewayRealtimeQueue` yaratadi.
 */
export function gatewayRealtimeConsumerOptions(
  uri: string,
  queue: string,
): RmqOptions {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [uri],
      queue,
      noAssert: true,
      noAck: false,
      // TCP_NODELAY — Nagle + delayed ACK har borib-kelishga ~43 ms
      // qo'shadi (o'lchangan: 45,4 → 2,6 ms). Batafsil: libs/common/rmq.
      socketOptions: {
        connectionOptions: { noDelay: true },
      },
      queueOptions: { durable: true },
    },
  };
}

/**
 * Gateway navbati yo'q bo'lsa — BIR MARTA `durable: true` bilan yaratadi;
 * bor bo'lsa TEGMAYDI. `startAllMicroservices` dan OLDIN chaqiriladi.
 *
 * NEGA. Iste'molchi ham (`noAssert: true`, yuqorida), mijozlar ham
 * (`libs/common/src/rmq/rmq.module.ts`) navbatni e'lon qilmaydi. Prod'da
 * navbat oldindan bor, lekin yangi (bo'sh) RabbitMQ'da uni hech kim
 * yaratmasdi: gateway har ~5 s «NOT_FOUND - no queue 'gateway_queue'» bilan
 * qayta ulanardi va realtime hodisalar (bildirishnoma, smena, sessiya kick)
 * jimgina yo'qolardi.
 *
 * ⚠️ NEGA `assertQueue` TO'G'RIDAN-TO'G'RI EMAS. Mavjud navbat boshqa
 * argumentlar bilan yaratilgan bo'lsa, qayta e'lon 406 PRECONDITION_FAILED
 * beradi (2026-09-14 prod to'xtashi — `RmqService.setupDlqTopology`). Shuning
 * uchun avval passiv `checkQueue`; faqat 404 NOT_FOUND bo'lsa yaratiladi.
 * Tekshiruv ALOHIDA ulanishda — 404 kanalni yopadi, iste'molchi kanaliga
 * tegmasin. Ikki replika bir vaqtda yaratsa ham xavfsiz: argumentlar bir xil.
 */
export async function ensureGatewayRealtimeQueue(
  uri: string,
  queue: string,
): Promise<'exists' | 'created'> {
  const connection = await amqplib.connect(uri, { timeout: 5_000 });
  // Kanal xatosi ulanishni yiqitmasligi uchun — biz uni O'ZIMIZ hal qilamiz.
  connection.on('error', () => undefined);
  try {
    const probe = await connection.createChannel();
    probe.on('error', () => undefined);
    try {
      await probe.checkQueue(queue);
      await probe.close().catch(() => undefined);
      return 'exists';
    } catch (error) {
      if ((error as { code?: number })?.code !== 404) throw error;
    }

    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    await channel.assertQueue(queue, { durable: true });
    await channel.close().catch(() => undefined);
    return 'created';
  } finally {
    await connection.close().catch(() => undefined);
  }
}
