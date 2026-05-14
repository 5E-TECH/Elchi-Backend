import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { InvestorServiceModule } from './investor-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'investor-service' });
  const app = await NestFactory.create(InvestorServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await rmqService.setupDlqTopology('INVESTOR');
  app.connectMicroservice(rmqService.getOptions('INVESTOR'));

  await app.startAllMicroservices();
  await app.listen(3020);
}
bootstrap();
