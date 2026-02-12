import { NestFactory } from '@nestjs/core';
import { C2cServiceModule } from './c2c-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(C2cServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('C2C'));

  await app.startAllMicroservices();
  await app.listen(3022);
}
bootstrap();
