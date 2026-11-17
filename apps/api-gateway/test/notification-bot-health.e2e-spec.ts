// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import './gateway-test-env';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import { createGatewayE2eApp, type MockClient } from './gateway-e2e.app';

/**
 * BOT-DIAG-BE — «Tizim holati»: Telegram bot nosozligining aniq sababi,
 * faqat superadmin. HAQIQIY ApiGatewayModule (global JwtAuthGuard +
 * JwtStrategy, RolesGuard, throttler); faqat RMQ mijozlari mock.
 *
 *  - tokensiz → 401; superadmin emas → 403 (servisga so'rov ketmaydi);
 *  - superadmin → 200: sabab (turi, status, matn, oxirgi tekshiruv);
 *  - «Qayta tekshirish» → `notification.bot.recheck`;
 *  - xizmat xatosi → 503 (o'zbekcha);
 *  - ochiq `/health/readiness` va `/notifications/health` — diagnostikasiz.
 */
const BOT = {
  enabled: true,
  mode: 'webhook',
  healthy: false,
  username: 'elchi_bot',
  reason: 'webhook (secret_token bilan)',
  checked_at: '2026-11-17T21:05:00.000Z',
  error_kind: 'network',
  error_status: null,
  error_text: 'Telegram getMe failed (0): fetch failed (ENOTFOUND)',
  restart_required: false,
};
const NOTIFICATION_HEALTH = {
  service: 'notification-service',
  status: 'degraded',
  bot: BOT,
  timestamp: '2026-11-17T21:05:01.000Z',
};
const RECHECK_REPLY = {
  ...NOTIFICATION_HEALTH,
  status: 'ok',
  bot: {
    ...BOT,
    healthy: true,
    checked_at: '2026-11-17T21:06:00.000Z',
    error_kind: null,
    error_text: null,
  },
  rechecked: true,
};

describe('BOT-DIAG-BE — /health/notification-bot (e2e, haqiqiy modul)', () => {
  let app: INestApplication;
  let notificationDown = false;
  let notificationSend: MockClient['send'];
  const jwt = new JwtService({ secret: process.env.ACCESS_TOKEN_KEY });
  const bearer = (role: string) =>
    `Bearer ${jwt.sign({ sub: '1', username: `u-${role}`, roles: [role] })}`;
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  beforeAll(async () => {
    const created = await createGatewayE2eApp((token, pattern) => {
      if (token === 'NOTIFICATION' || token === 'NOTIFICATION_BOT') {
        if (notificationDown) {
          return throwError(
            () => new Error('connect ECONNREFUSED 172.18.0.5:5672'),
          );
        }
        if (pattern.cmd === 'notification.health') {
          return of(NOTIFICATION_HEALTH);
        }
        if (pattern.cmd === 'notification.bot.recheck') {
          return of(RECHECK_REPLY);
        }
      }
      if (token === 'ORDER') return of('Hammasi chotki ishlayapti!');
      return of({ status: 'ok' });
    });
    app = created.app;
    notificationSend = created.clients.get('NOTIFICATION')!.send;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    notificationDown = false;
    notificationSend.mockClear();
  });

  const botCalls = () =>
    notificationSend.mock.calls.filter(
      ([pattern]) =>
        pattern.cmd === 'notification.health' ||
        pattern.cmd === 'notification.bot.recheck',
    );

  it.each([
    ['GET', '/health/notification-bot'],
    ['POST', '/health/notification-bot/recheck'],
  ] as const)(
    '⭐ %s %s — tokensiz 401, servisga so‘rov ketmaydi',
    async (method, path) => {
      const req = method === 'GET' ? http().get(path) : http().post(path);
      await req.expect(401);
      expect(botCalls()).toEqual([]);
    },
  );

  it.each(['admin', 'manager', 'registrator', 'courier', 'market', 'logist'])(
    '⭐ %s → 403 (ikkala marshrut), servisga so‘rov ketmaydi',
    async (role) => {
      await http()
        .get('/health/notification-bot')
        .set('Authorization', bearer(role))
        .expect(403);
      await http()
        .post('/health/notification-bot/recheck')
        .set('Authorization', bearer(role))
        .expect(403);
      expect(botCalls()).toEqual([]);
    },
  );

  it('⭐ superadmin GET → 200: sabab turi, status, qisqa matn, oxirgi tekshiruv', async () => {
    const res = await http()
      .get('/health/notification-bot')
      .set('Authorization', bearer('superadmin'))
      .expect(200);

    expect(res.body).toEqual({
      status: 'degraded',
      bot: BOT,
      timestamp: NOTIFICATION_HEALTH.timestamp,
    });
    expect(notificationSend).toHaveBeenCalledWith(
      { cmd: 'notification.health' },
      {},
    );
  });

  it('⭐ superadmin POST recheck → 200 (201 emas), notification.bot.recheck', async () => {
    const res = await http()
      .post('/health/notification-bot/recheck')
      .set('Authorization', bearer('superadmin'))
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      rechecked: true,
      bot: {
        healthy: true,
        error_kind: null,
        checked_at: RECHECK_REPLY.bot.checked_at,
      },
    });
    expect(notificationSend).toHaveBeenCalledWith(
      { cmd: 'notification.bot.recheck' },
      {},
    );
  });

  it('⭐ xizmat xatosi → 503 o‘zbekcha matn, xom sabab javobda yo‘q', async () => {
    notificationDown = true;
    const res = await http()
      .get('/health/notification-bot')
      .set('Authorization', bearer('superadmin'))
      .expect(503);
    const message = (res.body as { message?: string }).message ?? '';
    expect(message).toMatch(/Bildirishnoma xizmati/);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('⭐ ochiq /health/readiness o‘zgarmagan: faqat `reported degraded`, diagnostika yo‘q', async () => {
    const res = await http().get('/health/readiness').expect(503);
    const body = res.body as {
      services: Array<Record<string, unknown>>;
    };
    expect(
      body.services.find((s) => s.service === 'NOTIFICATION'),
    ).toMatchObject({
      status: 'down',
      error: 'reported degraded',
      error_kind: 'reported',
    });
    const json = JSON.stringify(res.body);
    for (const leak of ['ENOTFOUND', 'error_text', 'checked_at', 'elchi_bot']) {
      expect(json).not.toContain(leak);
    }
  });

  it('⭐ ochiq /notifications/health — bot faqat eski maydonlar bilan', async () => {
    const res = await http().get('/notifications/health').expect(200);
    expect(res.body).toEqual({
      service: 'notification-service',
      status: 'degraded',
      bot: {
        enabled: true,
        mode: 'webhook',
        healthy: false,
        username: 'elchi_bot',
        reason: 'webhook (secret_token bilan)',
      },
      timestamp: NOTIFICATION_HEALTH.timestamp,
    });
    expect(JSON.stringify(res.body)).not.toContain('ENOTFOUND');
  });
});
