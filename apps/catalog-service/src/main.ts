import { NestFactory } from '@nestjs/core';
import { CatalogServiceModule } from './catalog-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(CatalogServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('CATALOG'));

  await app.startAllMicroservices();
  await app.listen(3013);
}
bootstrap();
