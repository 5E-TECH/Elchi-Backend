import { NestFactory } from '@nestjs/core';
import { LogisticsServiceModule } from './logistics-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(LogisticsServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('LOGISTICS'));

  await app.startAllMicroservices();
  await app.listen(3014);
}
bootstrap();
