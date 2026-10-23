// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { of } from 'rxjs';
import { createGatewayE2eApp, type MockClient } from './gateway-e2e.app';

/**
 * (7s1bqOT6) Eski «Hello World!» sinovi o'rniga: `GET /` —
 * ApiGatewayController identity-service `identity.health` javobini qaytaradi
 * (prod'da `main.ts` `/` ni Swagger'ga yo'naltiradi; bu yerda — kontroller).
 * RabbitMQ'siz: mijozlar mock (`gateway-e2e.app.ts`).
 */
describe('ApiGatewayController (e2e)', () => {
  let app: INestApplication;
  let identity: MockClient;

  beforeAll(async () => {
    const created = await createGatewayE2eApp((token) =>
      of(token === 'IDENTITY' ? 'identity ok' : { status: 'ok' }),
    );
    app = created.app;
    identity = created.clients.get('IDENTITY')!;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('/ (GET) — identity.health javobi', async () => {
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/')
      .expect(200);

    expect(res.text).toBe('identity ok');
    expect(identity.send).toHaveBeenCalledWith({ cmd: 'identity.health' }, {});
  });
});
