import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { BranchServiceModule } from './branch-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'branch-service' });
  const app = await NestFactory.create(BranchServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);

  await rmqService.setupDlqTopology('BRANCH');
  app.connectMicroservice(rmqService.getOptions('BRANCH'));

  await app.startAllMicroservices();
  await app.listen(3019);
}
bootstrap();
