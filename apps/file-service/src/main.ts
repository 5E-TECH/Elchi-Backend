import { NestFactory } from '@nestjs/core';
import { FileServiceModule } from './file-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(FileServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.connectMicroservice(rmqService.getOptions('FILE'));

  await app.startAllMicroservices();
  await app.listen(3021);
}
bootstrap();
