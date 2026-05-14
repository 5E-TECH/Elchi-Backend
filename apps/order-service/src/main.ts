import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { OrderServiceModule } from './order-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'order-service' });
  const app = await NestFactory.create(OrderServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('ORDER');
  app.connectMicroservice(rmqService.getOptions('ORDER'));

  await app.startAllMicroservices();
  await app.listen(3012);
}
bootstrap();
