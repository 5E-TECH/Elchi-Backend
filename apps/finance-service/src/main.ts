import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { FinanceServiceModule } from './finance-service.module';
import {
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
} from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'finance-service' });
  const app = await NestFactory.create(FinanceServiceModule, {
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

  await rmqService.setupDlqTopology('FINANCE');
  // (f2Ud5tju) Hybrid app: `app.useGlobalInterceptors` faqat HTTP'ga
  // qo'llanadi — `inheritAppConfig` siz RMQ handler'larida RmqTraceInterceptor
  // UMUMAN ishlamasdi (trace_id / IP / qurilma servisga yetib bormasdi).
  // Enhancer'lar shu chaqiruvda nusxalanadi: bu yerdan KEYIN qo'shilgan
  // global pipe/filter RMQ'ga ta'sir qilmaydi.
  app.connectMicroservice(rmqService.getOptions('FINANCE'), {
    inheritAppConfig: true,
  });

  await app.startAllMicroservices();
  registerLiveness(app, 'finance-service');
  await app.listen(3015);
}
bootstrap();
