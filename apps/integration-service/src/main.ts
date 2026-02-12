import { NestFactory } from '@nestjs/core';
import { IntegrationServiceModule } from './integration-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(IntegrationServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('INTEGRATION'));

  await app.startAllMicroservices();
  await app.listen(3017);
}
bootstrap();
