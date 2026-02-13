import { NestFactory } from '@nestjs/core';
import { SearchServiceModule } from './search-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(SearchServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('SEARCH'));

  await app.startAllMicroservices();
  await app.listen(3023);
}
bootstrap();
