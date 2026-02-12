import { NestFactory } from '@nestjs/core';
import { NotificationServiceModule } from './notification-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(NotificationServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('NOTIFICATION'));

  await app.startAllMicroservices();
  await app.listen(3016);
}
bootstrap();
