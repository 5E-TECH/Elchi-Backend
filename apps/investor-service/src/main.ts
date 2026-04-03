import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { InvestorServiceModule } from './investor-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(InvestorServiceModule);
  const rmqService = app.get<RmqService>(RmqService);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.connectMicroservice(rmqService.getOptions('INVESTOR'));

  await app.startAllMicroservices();
  await app.listen(3020);
}
bootstrap();
