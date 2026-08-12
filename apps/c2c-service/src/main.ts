import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { C2cServiceModule } from './c2c-service.module';
import {
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
} from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'c2c-service' });
  const app = await NestFactory.create(C2cServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => {
    await flushSentry();
    await app.close();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    await flushSentry();
    await app.close();
    process.exit(0);
  });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('C2C');
  app.connectMicroservice(rmqService.getOptions('C2C'));

  await app.startAllMicroservices();
  registerLiveness(app, 'c2c-service');
  await app.listen(3022);
}
bootstrap();
