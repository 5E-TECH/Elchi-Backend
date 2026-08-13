import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { IntegrationServiceModule } from './integration-service.module';
import {
  RmqService,
  RmqTraceInterceptor,
  initSentry,
  flushSentry,
  registerLiveness,
} from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'integration-service' });
  const app = await NestFactory.create(IntegrationServiceModule, {
    bufferLogs: true,
  });
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

  await rmqService.setupDlqTopology('INTEGRATION');
  app.connectMicroservice(rmqService.getOptions('INTEGRATION'));

  await app.startAllMicroservices();
  registerLiveness(app, 'integration-service');
  await app.listen(3017);
}
bootstrap();
