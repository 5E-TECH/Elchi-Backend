import { RmqOptions, Transport } from '@nestjs/microservices';

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
 * o'zgarmagan — mavjud navbat qayta e'lon qilinmaydi.
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
