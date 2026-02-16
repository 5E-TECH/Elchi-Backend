import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiGatewayModule } from './api-gateway.module';
import { RpcExceptionFilter, AllExceptionsFilter } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);

  // Helmet konfiguratsiyasini o'zgartiramiz
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
          scriptSrc: [`'self'`, `https: 'unsafe-inline'`],
        },
      },
    }),
  );

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

  // Swagger setup qismiga CDN linklarini qo'shish oq ekranni 100% yo'qotadi
  SwaggerModule.setup('api', app, document, {
    customJs: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
    ],
    customCssUrl: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
    ],
  });

  // 0.0.0.0 qo'shish AWS da tashqi dunyo bilan ishlash uchun juda muhim
  const port = process.env.PORT || 3004;
  await app.listen(port, '0.0.0.0');
  console.log(`Gateway is running on: http://13.233.93.197:${port}/api`);
}
bootstrap();
