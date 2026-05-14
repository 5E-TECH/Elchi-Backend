import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AnalyticsServiceModule } from './analytics-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'analytics-service' });
  const app = await NestFactory.create(AnalyticsServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('ANALYTICS');
  app.connectMicroservice(rmqService.getOptions('ANALYTICS'));

  await app.startAllMicroservices();
  await app.listen(3018);
}
bootstrap();
