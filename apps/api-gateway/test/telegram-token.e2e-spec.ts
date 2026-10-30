// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import { createGatewayE2eApp } from './gateway-e2e.app';

/**
 * BOT-2 (#591 ko'rib chiqish, 7-band) — Telegram tokeni HAQIQIY
 * ApiGatewayModule ulanishida: global `TelegramScanScopeGuard` va
 * `JwtStrategy` + `TelegramTokenStateService` (provayder olib tashlansa yoki
 * guard ro'yxatdan chiqsa — shu test yiqiladi):
 *  - Mini App (`scope: 'tg_scan'`) tokeni → `GET /orders` 403, skan route
 *    scope'dan o'tadi;
 *  - identity `{ active: false }` → 401; identity xatosi → 503.
 */
describe('BOT-2 — Telegram tokeni (e2e, haqiqiy modul)', () => {
  let app: INestApplication;
  let identityState: () => unknown;
  const jwt = new JwtService({ secret: process.env.ACCESS_TOKEN_KEY });
  const token = (extra: Record<string, unknown>, sub = '25') =>
    jwt.sign({
      sub,
      username: 'k25',
      roles: ['courier'],
      branch_id: null,
      auth: 'telegram',
      tg_id: `55500${sub}`,
      ...extra,
    });
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  beforeAll(async () => {
    const created = await createGatewayE2eApp((clientToken, pattern) => {
      if (
        clientToken === 'IDENTITY' &&
        pattern.cmd === 'identity.auth.telegram_token_state'
      ) {
        return identityState() as never;
      }
      return of({ statusCode: 200, data: { items: [], total: 0 } });
    });
    app = created.app;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('⭐ tg_scan token → GET /orders 403 (scope guard)', async () => {
    identityState = () => of({ active: true });
    await http()
      .get('/orders')
      .set('Authorization', `Bearer ${token({ scope: 'tg_scan' }, '31')}`)
      .expect(403);
  });

  it('⭐ tg_scan token → POST /orders/scan-assign scope`dan o`tadi (403 EMAS)', async () => {
    identityState = () => of({ active: true });
    const res = await http()
      .post('/orders/scan-assign')
      .set('Authorization', `Bearer ${token({ scope: 'tg_scan' }, '32')}`)
      .send({ token: 'qr-token-123' });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('⭐ identity { active: false } → 401', async () => {
    identityState = () => of({ active: false });
    await http()
      .get('/orders')
      .set('Authorization', `Bearer ${token({}, '33')}`)
      .expect(401);
  });

  it('⭐ identity xatosi (hech tasdiqlanmagan) → 503', async () => {
    identityState = () => throwError(() => new Error('identity down'));
    await http()
      .get('/orders')
      .set('Authorization', `Bearer ${token({}, '34')}`)
      .expect(503);
  });
});
