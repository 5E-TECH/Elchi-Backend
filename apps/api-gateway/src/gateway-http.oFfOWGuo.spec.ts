import {
  Controller,
  Get,
  HttpException,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AllExceptionsFilter,
  SESSION_CHECK_UNAVAILABLE,
  registerMetrics,
} from '@app/common';
import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  HSTS_MAX_AGE_SECONDS,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  applyGatewaySecurityHeaders,
  applyServerTimeouts,
  gatewayCorsOptions,
  setupGatewaySwagger,
} from './gateway-http.setup';

@Controller()
class ProbeController {
  @Get('ping')
  ping() {
    return { ok: true };
  }

  @Get('busy')
  busy() {
    throw new ServiceUnavailableException({
      statusCode: 503,
      message: 'Sessiya holatini tekshirib bo‘lmadi',
      code: SESSION_CHECK_UNAVAILABLE,
    });
  }

  @Get('locked')
  locked() {
    throw new HttpException(
      {
        statusCode: 429,
        message: 'qulf',
        code: 'LOGIN_LOCKED',
        retry_after_seconds: 125,
      },
      429,
    );
  }
}

const FRONTEND = 'https://admin.elchipochta.uz';

/**
 * (oFfOWGuo) Gateway HTTP yuzasi — main.ts dagi AYNI funksiyalar
 * (`gateway-http.setup.ts`) haqiqiy Nest/Express ilovasida.
 */
describe('oFfOWGuo — gateway HTTP: preflight keshi, Retry-After, HSTS, Swagger, /metrics', () => {
  const envBackup = { ...process.env };
  let app: INestApplication;

  const build = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    const nest = moduleRef.createNestApplication({ logger: false });
    applyGatewaySecurityHeaders(nest);
    nest.enableCors(gatewayCorsOptions());
    nest.useGlobalFilters(new AllExceptionsFilter());
    setupGatewaySwagger(nest);
    registerMetrics(nest, 'api-gateway-spec');
    await nest.init();
    return nest;
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = `${FRONTEND},https://elchipochta.uz`;
    delete process.env.METRICS_TOKEN;
    delete process.env.SWAGGER_PASSWORD;
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...envBackup };
  });

  describe('CORS', () => {
    beforeEach(async () => {
      app = await build();
    });

    it('⭐ preflight: Access-Control-Max-Age = 7200 (har so‘rov oldidan OPTIONS takrorlanmaydi)', async () => {
      const res = await request(app.getHttpServer())
        .options('/ping')
        .set('Origin', FRONTEND)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.status).toBe(204);
      expect(CORS_PREFLIGHT_MAX_AGE_SECONDS).toBe(7200);
      expect(res.headers['access-control-max-age']).toBe('7200');
      expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('⭐ Retry-After JS’ga ochiq (exposedHeaders); avvalgi eksport sarlavhalari saqlangan', async () => {
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', FRONTEND);
      const exposed = String(res.headers['access-control-expose-headers'])
        .split(',')
        .map((h) => h.trim());
      expect(exposed).toEqual(
        expect.arrayContaining([
          'Retry-After',
          'Content-Disposition',
          'X-Export-Total',
          'X-Export-Limit',
          'X-Export-Truncated',
        ]),
      );
    });

    it('prodda begona origin va localhost — CORS sarlavhasi yo‘q (avvalgidek)', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:5173']) {
        const res = await request(app.getHttpServer())
          .get('/ping')
          .set('Origin', origin);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
    });
  });

  describe('Retry-After (429 / 503)', () => {
    beforeEach(async () => {
      app = await build();
    });

    it('⭐ 503 SESSION_CHECK_UNAVAILABLE — Retry-After: 5, tana o‘zgarmagan', async () => {
      const res = await request(app.getHttpServer())
        .get('/busy')
        .set('Origin', FRONTEND);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        statusCode: 503,
        code: SESSION_CHECK_UNAVAILABLE,
      });
      expect(res.headers['access-control-expose-headers']).toContain(
        'Retry-After',
      );
    });

    it('429 LOGIN_LOCKED — Retry-After tanadagi retry_after_seconds dan', async () => {
      const res = await request(app.getHttpServer()).get('/locked');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('125');
      expect(res.body).toMatchObject({ retry_after_seconds: 125 });
    });

    it('200 javobda Retry-After yo‘q', async () => {
      const res = await request(app.getHttpServer()).get('/ping');
      expect(res.headers['retry-after']).toBeUndefined();
    });
  });

  describe('HSTS', () => {
    it('⭐ Strict-Transport-Security yoqilgan (ilgari hsts: false), preload yo‘q', async () => {
      app = await build();
      const res = await request(app.getHttpServer()).get('/ping');
      expect(res.headers['strict-transport-security']).toBe(
        `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
      );
    });
  });

  describe('Swagger va `/`', () => {
    it('⭐ production: /api va /api-json yo‘q (parol bo‘lsa ham), `/` Swagger’ga yo‘naltirilmaydi', async () => {
      process.env.SWAGGER_PASSWORD = 'any-password-even-strong-1234567890';
      app = await build();
      const server = app.getHttpServer();
      expect((await request(server).get('/api')).status).toBe(404);
      expect((await request(server).get('/api-json')).status).toBe(404);
      const root = await request(server).get('/');
      expect(root.status).toBe(404);
      expect(root.headers.location).toBeUndefined();
    });

    it('dev: Swagger avvalgidek (parol bo‘lsa Basic Auth); `/` redirect yo‘q', async () => {
      process.env.NODE_ENV = 'development';
      process.env.SWAGGER_PASSWORD = 'dev-pass';
      app = await build();
      const server = app.getHttpServer();
      expect((await request(server).get('/api-json')).status).toBe(401);
      const ok = await request(server)
        .get('/api-json')
        .auth('admin', 'dev-pass');
      expect(ok.status).toBe(200);
      expect((await request(server).get('/')).status).toBe(404);
    });
  });

  describe('/metrics', () => {
    const TOKEN = 'm'.repeat(40);

    it('⭐ production + METRICS_TOKEN yo‘q — 404 (ilgari 200, ~240 KB)', async () => {
      app = await build();
      const res = await request(app.getHttpServer()).get('/metrics');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('http_request_duration_seconds');
    });

    it('⭐ METRICS_TOKEN: tokensiz / noto‘g‘ri — 401, to‘g‘ri Bearer — 200 Prometheus matni', async () => {
      process.env.METRICS_TOKEN = TOKEN;
      app = await build();
      const server = app.getHttpServer();
      const none = await request(server).get('/metrics');
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toContain('Bearer');
      expect(
        (
          await request(server)
            .get('/metrics')
            .set('Authorization', `Bearer ${TOKEN}x`)
        ).status,
      ).toBe(401);
      expect(
        (await request(server).get('/metrics').auth('admin', TOKEN)).status,
      ).toBe(401);
      const ok = await request(server)
        .get('/metrics')
        .set('Authorization', `Bearer ${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(ok.text).toContain('http_request_duration_seconds');
    });

    it('dev + token yo‘q — avvalgidek ochiq', async () => {
      process.env.NODE_ENV = 'development';
      app = await build();
      const res = await request(app.getHttpServer()).get('/metrics');
      expect(res.status).toBe(200);
    });
  });

  it('keepAlive 75 s / headers 76 s (headers > keepAlive)', () => {
    const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    applyServerTimeouts(server as never);
    expect(server).toEqual({
      keepAliveTimeout: SERVER_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: SERVER_HEADERS_TIMEOUT_MS,
    });
    expect(SERVER_KEEP_ALIVE_TIMEOUT_MS).toBe(75_000);
    expect(SERVER_HEADERS_TIMEOUT_MS).toBeGreaterThan(
      SERVER_KEEP_ALIVE_TIMEOUT_MS,
    );
  });

  it('main.ts shu funksiyalarni ishlatadi (helmet/CORS/Swagger/timeouts, `/` redirect yo‘q)', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toContain('applyGatewaySecurityHeaders(app)');
    expect(main).toContain('app.enableCors(gatewayCorsOptions())');
    expect(main).toContain('setupGatewaySwagger(app)');
    expect(main).toContain('applyServerTimeouts(app.getHttpServer())');
    expect(main).not.toMatch(/redirect\(/);
    expect(main).not.toMatch(/hsts:\s*false/);
  });
});
