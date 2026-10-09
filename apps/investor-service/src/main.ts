import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { InvestorServiceModule } from './investor-service.module';
import {
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
} from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'investor-service' });
  const app = await NestFactory.create(InvestorServiceModule, {
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

  await rmqService.setupDlqTopology('INVESTOR');
  // (f2Ud5tju) Hybrid app: `app.useGlobalInterceptors` faqat HTTP'ga
  // qo'llanadi — `inheritAppConfig` siz RMQ handler'larida RmqTraceInterceptor
  // UMUMAN ishlamasdi (trace_id / IP / qurilma servisga yetib bormasdi).
  // Enhancer'lar shu chaqiruvda nusxalanadi: bu yerdan KEYIN qo'shilgan
  // global pipe/filter RMQ'ga ta'sir qilmaydi.
  app.connectMicroservice(rmqService.getOptions('INVESTOR'), {
    inheritAppConfig: true,
  });
  // HTTP uchun (avvalgidek). RMQ handler'lariga QO'LLANMAYDI — ular yuqorida
  // yaratildi; payload'lar ValidationPipe'dan o'tmagan va o'tmaydi.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.startAllMicroservices();
  registerLiveness(app, 'investor-service');
  await app.listen(3020);
}
bootstrap();
