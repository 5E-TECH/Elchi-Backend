import { NestFactory } from '@nestjs/core';
import { UserServiceModule } from './user-service.module';
import { RmqService } from '@app/common'; // Biz yasagan lib

async function bootstrap() {
  const app = await NestFactory.create(UserServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  // User Service endi RabbitMQ dagi 'USER' kanalini eshitadi
  app.connectMicroservice(rmqService.getOptions('USER'));

  await app.startAllMicroservices();
  // HTTP porti (shart emas, lekin turaversin)
  await app.listen(3011);
}
bootstrap();
