import type { INestApplication } from '@nestjs/common';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import basicAuth from 'express-basic-auth';
import type { Server } from 'http';

/**
 * (oFfOWGuo) Gateway HTTP sozlamalari — main.ts dan ajratildi, spec'lar
 * aynan shu funksiyalarni haqiqiy Nest ilovasida tekshiradi.
 */

/**
 * Preflight keshi (oFfOWGuo #1): brauzer OPTIONS javobini shuncha soniya
 * saqlaydi — har login / refresh / `Authorization` so'rovidan oldin qo'shimcha
 * OPTIONS ketmaydi. Chrome 7200 s dan ortig'ini baribir 7200 ga qisqartiradi.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;

/**
 * Brauzer JS o'qiy oladigan javob sarlavhalari.
 * - xWsCAA5N: GET /orders/export/excel — fayl nomi va eksport chegarasi
 *   (X-Export-Truncated/Total/Limit).
 * - oFfOWGuo: `Retry-After` — 429 (throttle / login qulfi) va 503
 *   (`SESSION_CHECK_UNAVAILABLE`) da qancha kutish kerakligi.
 */
export const CORS_EXPOSED_HEADERS: readonly string[] = [
  'Content-Disposition',
  'X-Export-Total',
  'X-Export-Limit',
  'X-Export-Truncated',
  'Retry-After',
];

/**
 * Idempotency-Key — hisob-kitob formalari qayta bosilganda pul ikki marta
 * taqsimlanmasligi uchun (5hBeDuyn). X-Device-Id / X-Device-Name — jurnalga
 * qurilma (f2Ud5tju). X-Request-Source — j9KFyqlS (`courier-bulk`).
 */
export const CORS_ALLOWED_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'X-Device-Id',
  'X-Device-Name',
  'X-Request-Source',
];

/** `CORS_ORIGINS` (vergul bilan) → ro'yxat. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * ⚠️ LOCALHOST FAQAT DEV'DA (audit S4). Prodda frontend faqat `CORS_ORIGINS`
 * ro'yxatidagi domenlardan keladi; `credentials: true` bilan begona lokal
 * sahifa cookie'lar bilan API'ga murojaat qila olmasin.
 * Origin'siz (curl, server-to-server, socket.io'ning brauzer bo'lmagan
 * mijozlari) — ruxsat.
 */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin) return true;
  const isLocalhost =
    env.NODE_ENV !== 'production' &&
    (/^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  return isLocalhost || parseCorsOrigins(env.CORS_ORIGINS).includes(origin);
}

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * `cors` paketi formatidagi origin tekshiruvi — HTTP (`enableCors`) va
 * socket.io (`/realtime`, oFfOWGuo: ilgari `origin: true`) uchun BITTA qoida.
 * `process.env` har chaqiruvda o'qiladi (dekorator modul yuklanganda
 * baholanadi — env keyin ham to'g'ri bo'lsin).
 */
export function corsOriginCallback(
  origin: string | undefined,
  callback: OriginCallback,
): void {
  if (isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`CORS blocked for origin: ${origin}`), false);
}

export function gatewayCorsOptions(): CorsOptions {
  return {
    origin: corsOriginCallback,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

/**
 * Ochiq narx endpointlari (mSkzzNBJ): `/public/*` — elchipochta.uz landing
 * kalkulyatori. Landing domeni asosiy `CORS_ORIGINS` ga QO'SHILMAYDI: u
 * `credentials: true` bilan butun API'ga (jumladan `POST /auth/refresh`,
 * refresh cookie `SameSite=Lax`, elchipochta.uz ↔ api.elchipochta.uz bitta
 * «site») ochilib qolardi. `/public/*` uchun alohida qoida — cookie'siz
 * (`credentials: false`), faqat GET/POST va `Content-Type`.
 * `PUBLIC_CORS_ORIGINS` (vergul bilan) + asosiy ro'yxat (admin ham chaqira oladi).
 */
export const PUBLIC_CORS_PATH_PREFIX = '/public/';

export function isPublicCorsPath(url: string | undefined): boolean {
  return (url ?? '').startsWith(PUBLIC_CORS_PATH_PREFIX);
}

export function isAllowedPublicCorsOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isAllowedCorsOrigin(origin, env) ||
    parseCorsOrigins(env.PUBLIC_CORS_ORIGINS).includes(origin ?? '')
  );
}

export function publicCorsOptions(): CorsOptions {
  return {
    origin: (origin: string | undefined, callback: OriginCallback) => {
      if (isAllowedPublicCorsOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    exposedHeaders: ['Retry-After'],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

/** `enableCors` uchun: `/public/*` — `publicCorsOptions`, qolgani — `gatewayCorsOptions`. */
export function gatewayCorsDelegate(): CorsOptionsDelegate<{
  originalUrl?: string;
  url?: string;
}> {
  const main = gatewayCorsOptions();
  const pub = publicCorsOptions();
  return (req, callback) =>
    callback(null, isPublicCorsPath(req.originalUrl ?? req.url) ? pub : main);
}

/**
 * HSTS (oFfOWGuo, xavfsizlik P2): ilgari `hsts: false`. api.elchipochta.uz
 * faqat HTTPS (Cloudflare) orqali ochiladi; brauzer HTTP sahifadagi HSTS'ni
 * e'tiborsiz qoldiradi, shuning uchun lokal dev'ga ta'sir qilmaydi.
 * `preload` YO'Q (qaytarib bo'lmaydigan ro'yxat), muddat — 180 kun.
 */
export const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export function applyGatewaySecurityHeaders(app: INestApplication): void {
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: {
        maxAge: HSTS_MAX_AGE_SECONDS,
        includeSubDomains: true,
        preload: false,
      },
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
}

/**
 * keepAlive (oFfOWGuo #5): Node sukuti 5 s — cloudflared bo'sh ulanishni
 * uzoqroq ushlaydi va Node yopgan ulanishga so'rov yuborsa kam uchraydigan
 * 502 bo'ladi (POST qayta urinilmaydi). Server tomoni proksidan UZUNROQ
 * kutishi kerak (cloudflared sukuti — 90 s); `headersTimeout` > `keepAliveTimeout` (Node talabi).
 */
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const SERVER_HEADERS_TIMEOUT_MS = 96_000;

export function applyServerTimeouts(
  server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout'>,
): void {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
}

export type SwaggerSetupResult = 'mounted' | 'disabled_in_production';

/**
 * Swagger (oFfOWGuo, xavfsizlik P2): PRODUCTION'DA O'CHIQ — ilgari
 * `SWAGGER_PASSWORD` bo'lsa ochilardi (parol kuchliligi tekshirilmasdi,
 * basic-auth throttler'dan tashqarida edi). Frontend kontrakti
 * `docs/frontend/openapi.json` (`npm run openapi:generate`) dan olinadi,
 * jonli /api kerak emas. Dev'da avvalgidek: parol bo'lsa Basic Auth.
 * Domen ildizi (`/`) endi Swagger'ga yo'naltirilmaydi (404).
 */
export function setupGatewaySwagger(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): SwaggerSetupResult {
  if (env.NODE_ENV === 'production') return 'disabled_in_production';

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Elchi API Gateway')
    .setDescription('API Gateway docs for all microservice routes')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  const swaggerUser = env.SWAGGER_USER || 'admin';
  const swaggerPassword = env.SWAGGER_PASSWORD ?? '';
  // Basic Auth: /api (UI) va /api-json (xom OpenAPI schema).
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

  SwaggerModule.setup('api', app, document, {
    customJs: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-bundle.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui-standalone-preset.min.js',
    ],
    customCssUrl: [
      'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5/swagger-ui.min.css',
    ],
  });
  return 'mounted';
}
