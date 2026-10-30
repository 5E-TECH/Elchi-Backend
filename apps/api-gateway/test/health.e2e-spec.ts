// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import { GATEWAY_CLIENT_TOKENS } from './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import {
  createGatewayE2eApp,
  type GatewayClientToken,
  type MockClient,
} from './gateway-e2e.app';

/**
 * (7s1bqOT6) «Tizim holati» — backend e2e.
 *
 * TC: `GET /health` va `GET /health/readiness` turli javob beradi, readiness
 * `services` ichida barcha 14 servis nomi bor (bot navbati — NOTIFICATION ichida). Ilova — HAQIQIY
 * ApiGatewayModule (kontrollerlar modul tartibida); faqat RMQ mijozlari mock.
 * Ilgari `LogisticsGatewayController` `@Get('health')` (prefikssiz) bilan
 * `GET /health` ni egallab olgan edi — javob `logistics-service` ni nomlardi.
 */

// (BOT-3a) `NOTIFICATION_BOT` — notification-service'ning bot navbati
// alohida qator EMAS: `NOTIFICATION` qatorining `bot_queue` maydoni.
type ServiceToken = GatewayClientToken;
const SERVICES: ServiceToken[] = GATEWAY_CLIENT_TOKENS.filter(
  (token) => token !== 'NOTIFICATION_BOT',
);

const PROBE_CMD: Record<ServiceToken, string> = {
  IDENTITY: 'identity.health',
  ORDER: 'salom_ber_order',
  CATALOG: 'catalog.health',
  LOGISTICS: 'logistics.health',
  FINANCE: 'finance.health',
  NOTIFICATION: 'notification.health',
  NOTIFICATION_BOT: 'notification.health',
  INTEGRATION: 'integration.health',
  ANALYTICS: 'analytics.health',
  BRANCH: 'branch.health',
  INVESTOR: 'investor.health',
  FILE: 'file.health',
  C2C: 'c2c.health',
  SEARCH: 'search.health',
  AI: 'ai.health',
};

/** logistics-service `logistics.health` javobi (prod'dagi ko'rinishi). */
const LOGISTICS_HEALTH = {
  statusCode: 200,
  message: 'success',
  data: {
    service: 'logistics-service',
    status: 'ok',
    timestamp: '2026-09-20T16:35:44.850Z',
  },
};

interface ReadinessBody {
  status: string;
  timestamp: string;
  services: Array<{
    service: string;
    status: string;
    latency_ms?: number;
    error?: string;
    error_kind?: string;
    bot_queue?: { status: string; error_kind?: string };
  }>;
}

describe('7s1bqOT6 — GET /health va GET /health/readiness (e2e)', () => {
  let app: INestApplication;
  let clients: Map<GatewayClientToken, MockClient>;
  const down = new Set<GatewayClientToken>();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    ({ app, clients } = await createGatewayE2eApp((token, pattern) => {
      if (down.has(token)) {
        return throwError(() => new Error(`${token} navbati javob bermadi`));
      }
      if (token === 'LOGISTICS' && pattern.cmd === 'logistics.health') {
        return of(LOGISTICS_HEALTH);
      }
      if (token === 'ORDER') return of('Hammasi chotki ishlayapti!');
      return of({ status: 'ok' });
    }));
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    down.clear();
    for (const client of clients.values()) client.send.mockClear();
  });

  it("GET /health — gateway liveness (HealthController), logistics-service EMAS, RMQ'ga bormaydi", async () => {
    const res = await request(http()).get('/health').expect(200);
    const body = res.body as Record<string, unknown>;

    expect(body).toEqual({
      status: 'ok',
      service: 'api-gateway',
      timestamp: expect.any(String) as unknown,
      ai: expect.any(String) as unknown,
    });
    expect(JSON.stringify(body)).not.toContain('logistics-service');
    // Liveness hech bir servisni kutmaydi (AI holati — poller keshidan).
    for (const client of clients.values()) {
      expect(client.send).not.toHaveBeenCalled();
    }
  });

  it('GET /health/readiness — 200 ok, `services` da 14 servis; bot navbati NOTIFICATION ichida', async () => {
    const res = await request(http()).get('/health/readiness').expect(200);
    const body = res.body as ReadinessBody;

    expect(body.status).toBe('ok');
    expect(body.services).toHaveLength(SERVICES.length);
    expect(body.services.map((s) => s.service).sort()).toEqual(
      [...SERVICES].sort(),
    );
    for (const entry of body.services) {
      expect(entry.status).toBe('ok');
      expect(typeof entry.latency_ms).toBe('number');
    }
    expect(
      body.services.find((s) => s.service === 'NOTIFICATION')?.bot_queue,
    ).toMatchObject({ status: 'ok' });
    // Har servis (va bot navbati) o'z health buyrug'i bilan so'raldi.
    for (const token of GATEWAY_CLIENT_TOKENS) {
      expect(clients.get(token)!.send).toHaveBeenCalledWith(
        { cmd: PROBE_CMD[token] },
        {},
      );
    }
  });

  it('/health va /health/readiness — turli javob (liveness ≠ readiness)', async () => {
    const live = (await request(http()).get('/health').expect(200))
      .body as Record<string, unknown>;
    const ready = (await request(http()).get('/health/readiness').expect(200))
      .body as Record<string, unknown>;

    expect(live).not.toHaveProperty('services');
    expect(live.service).toBe('api-gateway');
    expect(ready).not.toHaveProperty('service');
    expect(Array.isArray(ready.services)).toBe(true);
  });

  it("bitta servis ishlamasa — 503 degraded, ro'yxatda baribir hammasi", async () => {
    down.add('ORDER');
    const res = await request(http()).get('/health/readiness').expect(503);
    const body = res.body as ReadinessBody;

    expect(body.status).toBe('degraded');
    expect(body.services).toHaveLength(SERVICES.length);
    const order = body.services.find((s) => s.service === 'ORDER');
    // (oFfOWGuo) @Public javobda xom xato matni yo'q — faqat holat matni.
    expect(order).toMatchObject({
      status: 'down',
      error: 'unavailable',
      error_kind: 'down',
    });
    expect(order?.error).not.toContain('ORDER');
    expect(
      body.services.filter((s) => s.service !== 'ORDER').map((s) => s.status),
    ).toEqual(Array(SERVICES.length - 1).fill('ok'));
  });

  it('⭐ BOT-3a: bot navbati iste`molchisiz — NOTIFICATION qatori down (bot_queue sababi), yangi qator yo`q', async () => {
    down.add('NOTIFICATION_BOT');
    const res = await request(http()).get('/health/readiness').expect(503);
    const body = res.body as ReadinessBody;
    expect(body.services).toHaveLength(SERVICES.length);
    expect(body.services.map((s) => s.service)).not.toContain(
      'NOTIFICATION_BOT',
    );
    expect(
      body.services.find((s) => s.service === 'NOTIFICATION'),
    ).toMatchObject({
      status: 'down',
      error_kind: 'down',
      bot_queue: { status: 'down', error_kind: 'down' },
    });
  });

  it('logistics-service health — endi `GET /logistics/health` da', async () => {
    const res = await request(http()).get('/logistics/health').expect(200);

    expect(res.body).toEqual(LOGISTICS_HEALTH);
    expect(clients.get('LOGISTICS')!.send).toHaveBeenCalledWith(
      { cmd: 'logistics.health' },
      {},
    );
  });
});
