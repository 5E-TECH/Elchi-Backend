import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { TelegramIdThrottlerGuard, telegramUserIdOf } from './auth/telegram-id-throttler.guard';
import { NotificationGatewayController } from './notification-gateway.controller';
import { TelegramGatewayController } from './telegram-gateway.controller';
import { AuthGatewayController } from './auth-gateway.controller';
import { ConfigService } from '@nestjs/config';

/**
 * 6jXw0DDr / 4TfLyTrL / 9uNhwTZp / td89SKXQ / xC88d8kH — gateway:
 *  - `POST /telegram/link-code`, `POST /users/me/telegram/link-code` — kim
 *    uchun FAQAT JWT'dan (tanadagi user_id/chat_id yo'q);
 *  - `DELETE /users/me/telegram` → identity.telegram.unlink (o'zi);
 *  - `GET /telegram/stats` — faqat admin/superadmin;
 *  - `POST /notifications/connect-by-token` — REGISTRATOR 403;
 *  - `POST /auth/telegram` — @Public, initData identity'ga, refresh/cookie YO'Q.
 */
describe('Telegram bog‘lash va kirish — gateway', () => {
  let app: INestApplication;
  const notificationSend = jest.fn();
  const identitySend = jest.fn();
  let user: { sub: string; roles: string[] } | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [
        TelegramGatewayController,
        NotificationGatewayController,
        AuthGatewayController,
      ],
      providers: [
        { provide: 'NOTIFICATION', useValue: { send: notificationSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        Reflector,
        TelegramIdThrottlerGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const handler = ctx.getHandler();
          const isPublic = Reflect.getMetadata('isPublic', handler) === true;
          if (isPublic) return true;
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = { ...user };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  type Call = [{ cmd: string }, Record<string, unknown>];

  beforeEach(() => {
    user = { sub: '25', roles: ['courier'] };
    notificationSend.mockReset().mockReturnValue(of({ statusCode: 200, data: {} }));
    identitySend.mockReset().mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  it('⭐ POST /users/me/telegram/link-code — user va rol JWT’dan, tanadagi user_id qabul qilinmaydi', async () => {
    await request(http()).post('/users/me/telegram/link-code').expect(201);
    const [pattern, payload] = notificationSend.mock.calls[0] as Call;
    expect(pattern).toEqual({ cmd: 'notification.telegram.link_code' });
    expect(payload).toEqual(
      expect.objectContaining({
        purpose: 'user',
        requester: { id: '25', roles: ['courier'] },
      }),
    );
  });

  it('POST /telegram/link-code — market_group (group_type, market_id) uzatiladi; begona maydon → 400', async () => {
    user = { sub: '37', roles: ['market'] };
    await request(http())
      .post('/telegram/link-code')
      .send({ purpose: 'market_group', group_type: 'cancel' })
      .expect(201);
    expect((notificationSend.mock.calls[0] as Call)[1]).toEqual(
      expect.objectContaining({
        purpose: 'market_group',
        group_type: 'cancel',
        requester: { id: '37', roles: ['market'] },
      }),
    );
    await request(http())
      .post('/telegram/link-code')
      .send({ purpose: 'user', user_id: '1' })
      .expect(400);
    await request(http())
      .post('/telegram/link-code')
      .send({ purpose: 'admin' })
      .expect(400);
  });

  it('⭐ DELETE /users/me/telegram → identity.telegram.unlink { user_id: JWT sub }', async () => {
    await request(http()).delete('/users/me/telegram').expect(200);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.telegram.unlink' },
      { user_id: '25' },
    );
  });

  it('autentifikatsiyasiz — 403 (JwtAuthGuard)', async () => {
    user = null;
    await request(http()).post('/users/me/telegram/link-code').expect(403);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it('GET /telegram/stats — faqat admin/superadmin', async () => {
    await request(http()).get('/telegram/stats').expect(403);
    user = { sub: '1', roles: ['admin'] };
    await request(http()).get('/telegram/stats').expect(200);
    expect(identitySend).toHaveBeenCalledWith({ cmd: 'identity.telegram.stats' }, {});
  });

  it('⭐ POST /notifications/connect-by-token — registrator 403', async () => {
    user = { sub: '77', roles: ['registrator'] };
    await request(http())
      .post('/notifications/connect-by-token')
      .send({ text: 'Q'.repeat(43), group_id: '-1001' })
      .expect(403);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it('⭐ POST /auth/telegram — @Public, initData identity’ga; refresh cookie qo‘yilmaydi', async () => {
    user = null;
    identitySend.mockReturnValue(
      of({ statusCode: 200, accessToken: 'jwt', access_token_expires_at: 1 }),
    );
    const res = await request(http())
      .post('/auth/telegram')
      .send({ init_data: 'user=%7B%22id%22%3A5550007%7D&auth_date=1&hash=x' })
      .expect(201);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.auth.telegram' },
      { init_data: 'user=%7B%22id%22%3A5550007%7D&auth_date=1&hash=x' },
    );
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).not.toHaveProperty('refreshToken');
    await request(http()).post('/auth/telegram').send({}).expect(400);
  });

  it('Telegram id bo‘yicha throttle kaliti initData’dagi user.id', () => {
    expect(telegramUserIdOf('user=%7B%22id%22%3A5550007%7D&hash=x')).toBe('5550007');
    expect(telegramUserIdOf('user=notjson')).toBeNull();
    expect(telegramUserIdOf('')).toBeNull();
  });
});
