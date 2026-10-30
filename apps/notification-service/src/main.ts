import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { NotificationServiceModule } from './notification-service.module';
import {
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
  registerMetrics,
} from '@app/common';
import { BOT_METRICS } from './bot/bot-metrics';

async function bootstrap() {
  initSentry({ serviceName: 'notification-service' });
  const app = await NestFactory.create(NotificationServiceModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', () => {
    void (async () => {
      await flushSentry();
      await app.close();
      process.exit(0);
    })();
  });
  process.on('SIGINT', () => {
    void (async () => {
      await flushSentry();
      await app.close();
      process.exit(0);
    })();
  });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('NOTIFICATION');
  // (f2Ud5tju) Hybrid app: `app.useGlobalInterceptors` faqat HTTP'ga
  // qo'llanadi — `inheritAppConfig` siz RMQ handler'larida RmqTraceInterceptor
  // UMUMAN ishlamasdi (trace_id / IP / qurilma servisga yetib bormasdi).
  // Enhancer'lar shu chaqiruvda nusxalanadi: bu yerdan KEYIN qo'shilgan
  // global pipe/filter RMQ'ga ta'sir qilmaydi.
  app.connectMicroservice(rmqService.getOptions('NOTIFICATION'), {
    inheritAppConfig: true,
  });
  /**
   * (BOT-3a) Telegram bot update'lari (gateway webhook) va karta hodisalari
   * (order-service outbox) — ALOHIDA navbat va iste'molchi. Umumiy
   * NOTIFICATION navbatidagi `notification.dispatch` / push to'lqini (bitta
   * dispatch Telegram'ni 10 s gacha kutadi) bot javobini kechiktirib, 60 s
   * TTL dan keyin update'ni DLQ'ga tushirardi. Handler'lar bir xil — faqat
   * navbat (prefetch, TTL, DLQ) ajratilgan.
   */
  await rmqService.setupDlqTopology('NOTIFICATION_BOT');
  app.connectMicroservice(rmqService.getOptions('NOTIFICATION_BOT'), {
    inheritAppConfig: true,
  });

  await app.startAllMicroservices();
  registerLiveness(app, 'notification-service');
  // (9HIaV80X #6) bot metrikalari (bot_token_healthy, bot_linked_users, …) —
  // ichki portdagi GET /metrics (tashqariga chiqarilmaydi).
  registerMetrics(app, 'notification-service', BOT_METRICS);
  await app.listen(3016);
}
bootstrap();
