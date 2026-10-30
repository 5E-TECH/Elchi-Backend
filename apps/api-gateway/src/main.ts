import { NestFactory } from '@nestjs/core';
import {
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { ApiGatewayModule } from './api-gateway.module';
import {
  ensureGatewayRealtimeQueue,
  gatewayRealtimeConsumerOptions,
} from './realtime/realtime-consumer.options';
import { requestContextMiddleware } from './context/request-context.middleware';
import {
  applyGatewaySecurityHeaders,
  applyServerTimeouts,
  gatewayCorsDelegate,
  setupGatewaySwagger,
} from './gateway-http.setup';
import {
  RpcExceptionFilter,
  AllExceptionsFilter,
  RmqService,
  initSentry,
  flushSentry,
  registerMetrics,
} from '@app/common';
import { aiParseStageSeconds } from './ai-order/ai-parse-metrics';

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

  // API versioning (audit api-design) — NON-BREAKING. URI versioning with both
  // the neutral (un-prefixed) and v1 default versions, so EVERY existing route
  // keeps working at its current path (`/orders`) for the current frontend AND
  // is simultaneously reachable at `/v1/orders`. New/changed endpoints can now
  // opt into `@Version('2')` without touching v1 clients. Raw adapter routes
  // (/health, /metrics) are unaffected — versioning applies to Nest controllers
  // only.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: [VERSION_NEUTRAL, '1'],
  });

  // Gateway Cloudflare Tunnel ortida ishlaydi. "trust proxy" yoqilganda
  // Express req.ip va rate-limiter X-Forwarded-For / CF-Connecting-IP'dan
  // haqiqiy mijoz IP'sini oladi — tunnel konteyneri IP'sini emas.
  app.set('trust proxy', true);

  // Trace correlation + audit konteksti (f2Ud5tju): x-request-id (yoki yangi
  // UUID) va haqiqiy mijoz IP'si / User-Agent / qurilma. Hammasi pino
  // loglari, chiquvchi RMQ xabarlari (AMQP sarlavhalari) va pastdagi har
  // servisga — u yerda `ActivityLogService.log()` metadata'siga — yetib boradi.
  // IP manbai `ClientIpThrottlerGuard` bilan AYNI (`resolveTrustedClientIp`).
  app.use(requestContextMiddleware);

  // Helmet (HSTS yoqilgan — oFfOWGuo) va CORS (preflight keshi 7200 s,
  // `Retry-After` JS'ga ochiq — oFfOWGuo; localhost faqat dev'da — audit S4).
  // Batafsil: gateway-http.setup.ts.
  applyGatewaySecurityHeaders(app);
  app.enableCors(gatewayCorsDelegate());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());

  try {
    // (oFfOWGuo) Production'da Swagger o'chiq; `/` endi /api ga yo'naltirilmaydi.
    if (setupGatewaySwagger(app) === 'disabled_in_production') {
      app
        .get(Logger)
        .log('Swagger UI production rejimida o`chirilgan (oFfOWGuo)');
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
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Hybrid RMQ consumer: lets any service push to socket.io clients by emitting
  // { cmd: 'realtime.notify' } to the gateway queue (see realtime.controller).
  const gatewayQueue = process.env.RABBITMQ_GATEWAY_QUEUE;
  // (rWdLuoP3) Handlerlar xabarni o'zi ack qiladi — `noAck: false`
  // (realtime-consumer.options.ts).
  if (gatewayQueue) {
    // Yangi RabbitMQ'da navbatni hech kim yaratmaydi (`noAssert: true`) —
    // yo'q bo'lsa shu yerda bir marta yaratiladi; mavjudiga tegilmaydi.
    // Broker yetib bo'lmasa boot yiqilmaydi: transport o'zi qayta ulanadi.
    try {
      const status = await ensureGatewayRealtimeQueue(
        process.env.RABBITMQ_URI!,
        gatewayQueue,
      );
      if (status === 'created') {
        app.get(Logger).log(`Gateway navbati yaratildi: ${gatewayQueue}`);
      }
    } catch (error) {
      // nestjs-pino: oxirgi argument — context; matn `msg` ga tushishi uchun.
      app
        .get(Logger)
        .warn(
          { err: error },
          `Gateway navbati (${gatewayQueue}) tekshirilmadi — yo'q bo'lsa realtime hodisalar kelmaydi`,
          'GatewayRealtimeQueue',
        );
    }
    app.connectMicroservice<MicroserviceOptions>(
      gatewayRealtimeConsumerOptions(process.env.RABBITMQ_URI!, gatewayQueue),
    );
    await app.startAllMicroservices();
  }

  /**
   * (BOT-3a) Telegram webhook update'lari alohida `NOTIFICATION_BOT`
   * navbatiga ketadi. Navbatni notification-service (iste'molchi) yaratadi;
   * u hali ko'tarilmagan bo'lsa (bir vaqtda deploy, yangi broker) gateway
   * yuborgan update JIM yo'qolardi — shuning uchun gateway ham ayni
   * argumentlar bilan e'lon qiladi. Xato deploy'ni to'xtatmaydi.
   */
  try {
    await app.get(RmqService).ensureQueue('NOTIFICATION_BOT');
  } catch (error) {
    app
      .get(Logger)
      .warn(
        { err: error },
        "NOTIFICATION_BOT navbati e'lon qilinmadi — notification-service yaratadi",
        'NotificationBotQueue',
      );
  }

  // Prometheus metrics: /metrics + request histogram + process/GC defaults.
  // (oFfOWGuo) /metrics faqat `Authorization: Bearer <METRICS_TOKEN>` bilan;
  // production'da token yo'q bo'lsa 404 (tunnel orqali ochiq edi).
  // Registered before listen so the middleware wraps all routes.
  // WHMAIqyo #5: ai-parse bosqichlari histogrammasi (p50/p95).
  registerMetrics(app, 'api-gateway', [aiParseStageSeconds]);

  // AWS va Docker interfeyslari uchun 0.0.0.0 majburiy
  const port = Number(process.env.PORT || 3004);
  await app.listen(port, '0.0.0.0');
  // (oFfOWGuo) keepAlive 75 s / headers 76 s — cloudflared'dan uzunroq.
  applyServerTimeouts(app.getHttpServer());

  app.get(Logger).log(`Gateway is running on: http://localhost:${port}/api`);
}
bootstrap();
