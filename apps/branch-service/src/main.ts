import { NestFactory } from '@nestjs/core';
import { BranchServiceModule } from './branch-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(BranchServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('BRANCH'));

  await app.startAllMicroservices();
  await app.listen(3019);
}
bootstrap();
