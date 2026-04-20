import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IdentityServiceModule } from './identity-service.module';
import { RmqService } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(IdentityServiceModule);
  const rmqService = app.get<RmqService>(RmqService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.connectMicroservice(rmqService.getOptions('IDENTITY'));

  await app.startAllMicroservices();
  await app.listen(Number(process.env.IDENTITY_PORT || 3011));
}
bootstrap();
