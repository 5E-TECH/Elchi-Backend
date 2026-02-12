import { NestFactory } from '@nestjs/core';
import { AnalyticsServiceModule } from './analytics-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(AnalyticsServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('ANALYTICS'));

  await app.startAllMicroservices();
  await app.listen(3018);
}
bootstrap();
