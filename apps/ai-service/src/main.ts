import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { Logger } from 'nestjs-pino';
import { AiServiceModule } from './ai-service.module';
import {
  startAiDlqDrain,
  type AiDlqDrain,
  type DlqDrainConnection,
} from './rpc/run-ai-handler';
import {
  ClaudeService,
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
} from '@app/common';

/** AI_RMQ_PREFETCH sukuti (aiValidationSchema bilan bir xil). */
const AI_RMQ_PREFETCH_DEFAULT = 8;

/** amqplib'da TS tiplari yo'q — drain faqat `connect`ni ishlatadi. */
const amqp = amqplib as unknown as {
  connect(url: string): Promise<DlqDrainConnection>;
};

async function bootstrap() {
  initSentry({ serviceName: 'ai-service' });
  const app = await NestFactory.create(AiServiceModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  let dlqDrain: AiDlqDrain | null = null;
  process.on('SIGTERM', () => {
    void (async () => {
      await dlqDrain?.stop();
      await flushSentry();
      await app.close();
      process.exit(0);
    })();
  });
  process.on('SIGINT', () => {
    void (async () => {
      await dlqDrain?.stop();
      await flushSentry();
      await app.close();
      process.exit(0);
    })();
  });
  const rmqService = app.get<RmqService>(RmqService);
  const config = app.get<ConfigService>(ConfigService);
  const claude = app.get<ClaudeService>(ClaudeService);

  await rmqService.setupDlqTopology('AI');
  const opts = rmqService.getOptions('AI');
  // ⚠️ Faqat kanal QoS (prefetch): bir vaqtda nechta Anthropic chaqiruvi
  // ochiq turishini cheklaydi. Navbat argumentlari (x-message-ttl, DLX)
  // O'ZGARTIRILMAYDI — ular rmq.service.ts'da bitta manbadan (2026-09-14
  // PRECONDITION_FAILED hodisasi).
  opts.options!.prefetchCount =
    config.get<number>('AI_RMQ_PREFETCH') ?? AI_RMQ_PREFETCH_DEFAULT;
  // (f2Ud5tju) Hybrid app: `app.useGlobalInterceptors` faqat HTTP'ga
  // qo'llanadi — `inheritAppConfig` siz RMQ handler'larida RmqTraceInterceptor
  // UMUMAN ishlamasdi (trace_id / IP / qurilma servisga yetib bormasdi).
  // Enhancer'lar shu chaqiruvda nusxalanadi: bu yerdan KEYIN qo'shilgan
  // global pipe/filter RMQ'ga ta'sir qilmaydi.
  app.connectMicroservice(opts, { inheritAppConfig: true });

  // ⚠️ MAXFIYLIK (HD5zOyBp #11/#16): muddati o'tgan `ai.order.extract` xabari
  // (xom matn + base64 rasmlar) `ai_queue_dlq`ga tushadi — u TTL'siz va
  // iste'molchisiz, ya'ni rasm RabbitMQ diskida MUDDATSIZ qolardi. Drain har
  // xabarni darhol ack qilib tashlaydi, logga faqat cmd/sabab/son yoziladi.
  // Navbat argumentlari O'ZGARMAYDI; DLQ yuqoridagi setupDlqTopology'da
  // e'lon qilingan (nom rmq.service.ts bilan bir xil: `${queue}_dlq`).
  const rmqUrl = config.get<string>('RABBITMQ_URI')!;
  dlqDrain = startAiDlqDrain({
    connect: () => amqp.connect(rmqUrl),
    queue: `${opts.options!.queue}_dlq`,
    logger: new NestLogger('AiDlqDrain'),
  });

  await app.startAllMicroservices();
  // /health → { ai: 'enabled' | 'disabled' } (bVeyEuIR #2). Sinxron va arzon —
  // RMQ/DB'ga bormaydi, har healthcheck'da chaqiriladi.
  registerLiveness(app, 'ai-service', () => ({
    ai: claude.isEnabled() ? 'enabled' : 'disabled',
  }));
  await app.listen(3024);
}
void bootstrap();
