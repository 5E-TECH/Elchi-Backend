import { NestFactory } from '@nestjs/core';
import { FinanceServiceModule } from './finance-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(FinanceServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('FINANCE'));

  await app.startAllMicroservices();
  await app.listen(3015);
}
bootstrap();
