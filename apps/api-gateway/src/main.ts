import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiGatewayModule } from './api-gateway.module';
import {
  RpcExceptionFilter,
  AllExceptionsFilter,
  requestContext,
  initSentry,
  flushSentry,
} from '@app/common';

async function bootstrap() {
  // Initialise Sentry before app creation so any boot-time errors are captured.
  // No-op if SENTRY_DSN is unset (dev/local).
  initSentry({ serviceName: 'api-gateway' });

  const app = await NestFactory.create(ApiGatewayModule, { bufferLogs: true });
  app.enableShutdownHooks();
  // Replace the built-in Nest logger with Pino so every line (incl. ones
  // emitted by Nest internals) goes through the structured pipeline.
  app.useLogger(app.get(Logger));

  // Trace correlation: read x-request-id from the client (typical proxy
  // pattern) or mint a fresh one. The id propagates through pino logs,
  // outgoing RMQ calls (libs/common rmqSend), and on into every downstream
  // service via the trace_id payload field.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const headerId = req.headers['x-request-id'];
    const traceId =
      typeof headerId === 'string' && headerId.trim()
        ? headerId.trim()
        : Array.isArray(headerId) && headerId[0]?.trim()
          ? headerId[0].trim()
          : randomUUID();
    res.setHeader('x-request-id', traceId);
    requestContext.run({ traceId }, () => next());
  });

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

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
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) may not send Origin.
      if (!origin) {
        callback(null, true);
        return;
      }

      const isLocalhost =
        /^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);

      if (isLocalhost || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
    app.get(Logger).error({ err: error }, 'Swagger initialization failed');
  }

  // Flush pending Sentry events on SIGTERM/SIGINT so the process exits
  // without losing in-flight error reports.
  const shutdown = async () => {
    await flushSentry().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // AWS va Docker interfeyslari uchun 0.0.0.0 majburiy
  const port = Number(process.env.PORT || 3004);
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`Gateway is running on: http://localhost:${port}/api`);
}
bootstrap();
