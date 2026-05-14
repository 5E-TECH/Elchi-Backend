import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { SearchServiceModule } from './search-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'search-service' });
  const app = await NestFactory.create(SearchServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('SEARCH');
  app.connectMicroservice(rmqService.getOptions('SEARCH'));

  await app.startAllMicroservices();
  await app.listen(3023);
}
bootstrap();
