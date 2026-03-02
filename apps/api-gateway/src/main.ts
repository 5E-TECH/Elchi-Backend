import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiGatewayModule } from './api-gateway.module';
import { RpcExceptionFilter, AllExceptionsFilter } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);

  // Helmet-ni HTTP uchun moslaymiz
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // HTTPS-ga majburlashni butunlay o'chiramiz
      hsts: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          styleSrc: [
            `'self'`,
            `'unsafe-inline'`,
            'https://cdnjs.cloudflare.com',
          ],
          imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
          scriptSrc: [
            `'self'`,
            `'unsafe-inline'`,
            `'unsafe-eval'`,
            'https://cdnjs.cloudflare.com',
          ],
          upgradeInsecureRequests: null, // HTTP -> HTTPS avtomatik o'tkazishni o'chirish
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

  try {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Elchi API Gateway')
      .setDescription('API Gateway docs for all microservice routes')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // Swagger Setup
    SwaggerModule.setup('api', app, document, {
      customJs: [
        'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
      ],
      customCssUrl: [
        'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
      ],
    });
  } catch (error) {
    // Swagger schema xatosi bo'lsa ham API ishlashda davom etadi.
    console.error('Swagger initialization failed:', error);
  }

 
  // AWS va Docker interfeyslari uchun 0.0.0.0 majburiy
  const port = Number(process.env.PORT || 3004);
  await app.listen(port, '0.0.0.0');

  console.log(`Gateway is running on: http://localhost:${port}/api`);
}
bootstrap();
