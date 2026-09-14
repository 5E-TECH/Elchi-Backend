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

  private getQueueNames(queueId: string): {
    main: string;
    dlq: string;
    dlx: string;
  } {
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
   *
   * ⚠️ SHU YERDA MAVJUD NAVBAT ARGUMENTLARI HAM TEKSHIRILADI.
   *
   * NEGA. 2026-09-14 da produksiya TO'LIQ TO'XTADI: `RMQ_RPC_TTL_MS` sukuti
   * 10 000 dan 60 000 ga o'zgartirildi, RabbitMQ esa MAVJUD navbatning
   * argumentini o'zgartirishga ruxsat bermaydi —
   * `PRECONDITION_FAILED: inequivalent arg 'x-message-ttl'`. NestJS RMQ
   * transporti navbatni o'zi e'lon qiladi, xato esa KANAL darajasida
   * yuzaga keladi va jurnalga TUSHMAYDI: 14 ta servis ham "Up" ko'rinadi,
   * birortasida iste'molchi yo'q, har bir so'rov 504 bilan tugaydi. Ya'ni
   * eng yomon nosozlik turi — belgisiz.
   *
   * Endi startda navbat argumentlari ataylab tekshiriladi va nomuvofiqlik
   * ANIQ xato + tuzatish buyrug'i bilan jurnalga yoziladi. Bu tekshiruv
   * nosozlikni to'sa olmaydi (navbatni e'lon qilish baribir transportning
   * ishi), lekin sababni bir zumda ko'rsatadi.
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

    await this.assertMainQueueArgsMatch(url, queueId, main);
  }

  /**
   * Mavjud asosiy navbat argumentlari kod kutayotgani bilan mos keladimi.
   *
   * Tekshiruv ALOHIDA kanalda bajariladi: `assertQueue` nomuvofiqlikda
   * kanalni yopadi, ya'ni uni DLQ o'rnatilishi bilan bitta kanalda
   * qilib bo'lmaydi.
   */
  private async assertMainQueueArgsMatch(
    url: string,
    queueId: string,
    main: string,
  ): Promise<void> {
    const expected = this.mainQueueArguments(queueId);
    const connection = await amqplib.connect(url);
    const channel = await connection.createChannel();

    // Kanal xatosi ulanishni yiqitmasligi uchun — biz uni O'ZIMIZ hal qilamiz.
    channel.on('error', () => undefined);

    try {
      await channel.checkQueue(main);
    } catch {
      // Navbat hali yo'q — transport uni to'g'ri argumentlar bilan yaratadi.
      await connection.close().catch(() => undefined);
      return;
    }

    try {
      const verifyChannel = await connection.createChannel();
      verifyChannel.on('error', () => undefined);
      await verifyChannel.assertQueue(main, {
        durable: true,
        ...expected,
      });
      await verifyChannel.close().catch(() => undefined);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(
        `⚠️ NAVBAT ARGUMENTLARI MOS EMAS: '${main}'.\n` +
          `   ${message}\n` +
          `   Sabab: kodda navbat argumenti o'zgargan, RabbitMQ esa MAVJUD ` +
          `navbatni qayta e'lon qilishga ruxsat bermaydi.\n` +
          `   Oqibati: bu servis navbatga ULANA OLMAYDI — iste'molchi ` +
          `bo'lmaydi va so'rovlar 504 bilan tugaydi.\n` +
          `   Tuzatish (navbat BO'SH ekanini tekshirib): ` +
          `docker exec elchi-rabbitmq rabbitmqctl delete_queue ${main}`,
      );
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  /**
   * Asosiy navbatning argumentlari — `getOptions` bilan BITTA manbadan.
   * Ikki joyda takrorlansa, ular jimgina ajralib ketadi va aynan shu
   * nomuvofiqlik produksiyani to'xtatadi.
   */
  private mainQueueArguments(queueId: string): {
    messageTtl: number;
    deadLetterExchange: string;
    deadLetterRoutingKey: string;
  } {
    const { dlq, dlx } = this.getQueueNames(queueId);
    return {
      messageTtl: this.resolveTtlMs(),
      deadLetterExchange: dlx,
      deadLetterRoutingKey: dlq,
    };
  }

  /**
   * Navbatdagi xabarning yashash muddati (audit C5).
   *
   * ⚠️ BU QIYMATNI O'ZGARTIRISH — INFRATUZILMA O'ZGARISHI, ODDIY DEPLOY EMAS.
   * RabbitMQ mavjud navbatning argumentini o'zgartirishga ruxsat bermaydi;
   * o'zgartirilsa har bir servis navbatga ulana olmay qoladi (2026-09-14
   * produksiya to'xtashi aynan shundan bo'lgan). Yangi qiymatga o'tish
   * tartibi: navbatlar BO'SH ekaniga ishonch hosil qiling →
   * `rabbitmqctl delete_queue <navbat>` → servislarni qayta ishga tushiring.
   *
   * NEGA 60 000. 10 sekund navbatda KUTISH vaqtini cheklardi: iste'molchi
   * band bo'lsa xabar kechikmasdan DLQ'ga tushardi, ya'ni yuk oshganda tizim
   * sekinlashmasdan YO'QOTA boshlardi. 60 s — RPC timeout'laridan (5–10 s)
   * ancha katta, normal ishda hech qachon tegmaydi.
   */
  private resolveTtlMs(): number {
    const ttl = Number(
      this.configService.get<string>('RMQ_RPC_TTL_MS') ?? 60000,
    );
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 60000;
  }

  getOptions(queueId: string, noAck = false): RmqOptions {
    // TTL bitta manbadan (`resolveTtlMs`) — startdagi tekshiruv ham,
    // transport ham aynan bir xil qiymatni ishlatishi SHART, aks holda
    // ular jimgina ajralib ketadi va navbat e'loni yiqiladi.
    const ttl = this.resolveTtlMs();
    // Per-consumer prefetch: bound how many unacked messages a single service
    // instance holds (Scale NOW-1). With prefetch UNSET (NestJS default 0 =
    // unlimited) a burst shovels unbounded messages into one Node event loop,
    // inflating per-message latency past the 5s/8s RPC timeouts and triggering
    // retry storms; a finite window turns the queue into real backpressure.
    // Money-safe: messages are still individually acked/nacked (noAck=false) and
    // every handler is idempotent (request_id + the cashbox UNIQUE dedup index),
    // so a redelivery from the bounded window can never double-post.
    const prefetch = Number(
      this.configService.get<string>('RMQ_PREFETCH') ?? 20,
    );
    const { main, dlq, dlx } = this.getQueueNames(queueId);

    return {
      transport: Transport.RMQ,
      options: {
        urls: [this.configService.get<string>('RABBITMQ_URI')!],
        queue: main,
        prefetchCount:
          Number.isFinite(prefetch) && prefetch > 0 ? prefetch : 20,
        isGlobalPrefetchCount: false,
        queueOptions: {
          durable: true,
          messageTtl: ttl,
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
