import { NestFactory } from '@nestjs/core';
import { IdentityServiceModule } from './identity-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(IdentityServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('IDENTITY'));

  await app.startAllMicroservices();
  await app.listen(3011);
}
bootstrap();
