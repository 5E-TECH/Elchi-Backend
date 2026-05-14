import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { IdentityServiceModule } from './identity-service.module';
import { RmqService, RmqTraceInterceptor, initSentry, flushSentry } from '@app/common';

async function bootstrap() {
  initSentry({ serviceName: 'identity-service' });
  const app = await NestFactory.create(IdentityServiceModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalInterceptors(new RmqTraceInterceptor());
  process.on('SIGTERM', async () => { await flushSentry(); await app.close(); process.exit(0); });
  process.on('SIGINT', async () => { await flushSentry(); await app.close(); process.exit(0); });
  const rmqService = app.get<RmqService>(RmqService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await rmqService.setupDlqTopology('IDENTITY');
  app.connectMicroservice(rmqService.getOptions('IDENTITY'));

  await app.startAllMicroservices();
  await app.listen(Number(process.env.IDENTITY_PORT || 3011));
}
bootstrap();
