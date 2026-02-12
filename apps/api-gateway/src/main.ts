import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiGatewayModule } from './api-gateway.module';
import { RpcExceptionFilter, AllExceptionsFilter } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);

  app.use(helmet());

  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Elchi API Gateway')
    .setDescription('API Gateway docs for all microservice routes')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT ?? 2004);
}
bootstrap();
