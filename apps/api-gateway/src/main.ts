import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import basicAuth from 'express-basic-auth';
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

  const app = await NestFactory.create<NestExpressApplication>(
    ApiGatewayModule,
    // rawBody: true exposes req.rawBody (Buffer) so inbound provider webhooks
    // can be HMAC-verified against the exact bytes received, before JSON
    // re-serialisation could change them.
    { bufferLogs: true, rawBody: true },
  );
  app.enableShutdownHooks();
  // Replace the built-in Nest logger with Pino so every line (incl. ones
  // emitted by Nest internals) goes through the structured pipeline.
  app.useLogger(app.get(Logger));

  // Gateway Cloudflare Tunnel ortida ishlaydi. "trust proxy" yoqilganda
  // Express req.ip va rate-limiter X-Forwarded-For / CF-Connecting-IP'dan
  // haqiqiy mijoz IP'sini oladi — tunnel konteyneri IP'sini emas.
  app.set('trust proxy', true);

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

    const swaggerUser = process.env.SWAGGER_USER ?? 'admin';
    const swaggerPassword = process.env.SWAGGER_PASSWORD ?? '';
    const isProd = process.env.NODE_ENV === 'production';

    // Productionда Swagger faqat parol belgilangandagina ochiladi va u
    // har doim HTTP Basic Auth bilan himoyalanadi. Parol bo'lmasa — Swagger
    // umuman mount qilinmaydi (xato bilan ochiq qolib ketmasligi uchun).
    if (isProd && !swaggerPassword) {
      app
        .get(Logger)
        .warn(
          'SWAGGER_PASSWORD belgilanmagan — Swagger UI production rejimida o`chirildi',
        );
    } else {
      // Basic Auth: /api (UI) va /api-json (xom OpenAPI schema) himoyalanadi.
      // Parol mavjud bo'lsa qo'llanadi; dev rejimda parolsiz ham ochiq qoladi.
      if (swaggerPassword) {
        app.use(
          ['/api', '/api-json'],
          basicAuth({
            users: { [swaggerUser]: swaggerPassword },
            challenge: true,
            realm: 'Elchi API Docs',
          }),
        );
      }

      // Domеn ildiziga (`/`) kirilganda to'g'ridan-to'g'ri Swagger UI ochilsin.
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/') {
          res.redirect('/api');
          return;
        }
        next();
      });

      SwaggerModule.setup('api', app, document, {
        customJs: [
          'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
          'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
        ],
        customCssUrl: [
          'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
        ],
      });
    }
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

  // Hybrid RMQ consumer: lets any service push to socket.io clients by emitting
  // { cmd: 'realtime.notify' } to the gateway queue (see realtime.controller).
  const gatewayQueue = process.env.RABBITMQ_GATEWAY_QUEUE;
  if (gatewayQueue) {
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URI!],
        queue: gatewayQueue,
        noAssert: true,
        queueOptions: { durable: true },
      },
    });
    await app.startAllMicroservices();
  }

  // AWS va Docker interfeyslari uchun 0.0.0.0 majburiy
  const port = Number(process.env.PORT || 3004);
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`Gateway is running on: http://localhost:${port}/api`);
}
bootstrap();
