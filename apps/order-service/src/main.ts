import { NestFactory } from '@nestjs/core';
import { OrderServiceModule } from './order-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(OrderServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('ORDER'));

  await app.startAllMicroservices();
  await app.listen(3012);
}
bootstrap();
