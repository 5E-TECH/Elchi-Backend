import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * WEB PUSH marshrutlari (kf0uVbyg):
 * - `push/...` statik segmentlar telegram-config `:id` marshrutlaridan OLDIN
 *   e'lon qilingan — `GET /notifications/push/public-key` `GET :id` ga tushmaydi;
 * - `user_id` FAQAT JWT'dan olinadi: body'da yuborilsa 400 (forbidNonWhitelisted),
 *   ya'ni boshqa foydalanuvchi nomidan obuna yaratib/o'chirib bo'lmaydi;
 * - endpoint faqat https.
 */
describe('NotificationGatewayController — web push', () => {
  let app: INestApplication;
  const send = jest.fn();
  let authenticated = true;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationGatewayController],
      providers: [{ provide: 'NOTIFICATION', useValue: { send } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!authenticated) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '42',
            roles: ['courier'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // main.ts dagi global pipe bilan bir xil.
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

  beforeEach(() => {
    authenticated = true;
    send.mockReset();
    send.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;

  const body = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'BNcR', auth: 'tBHI' },
    user_agent: 'Mozilla/5.0',
    platform: 'android',
    is_standalone: false,
  };

  it("GET /notifications/push/public-key -> 'notification.push.public_key' (`:id` ga TUSHMAYDI)", async () => {
    const res = await request(http()).get('/notifications/push/public-key');
    expect(res.status).toBe(200);
    expect(lastCall()?.[0]).toEqual({ cmd: 'notification.push.public_key' });
  });

  it('POST /notifications/push/subscribe forwards the body with user_id taken from the JWT', async () => {
    const res = await request(http())
      .post('/notifications/push/subscribe')
      .send(body);
    expect(res.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'notification.push.subscribe' },
      { ...body, user_id: '42' },
    ]);
  });

  it('rejects a user_id in the body (cannot subscribe on behalf of someone else)', async () => {
    const res = await request(http())
      .post('/notifications/push/subscribe')
      .send({ ...body, user_id: '7' });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a non-https endpoint, missing keys and an unknown platform', async () => {
    for (const bad of [
      { ...body, endpoint: 'http://push.example/abc' },
      { ...body, keys: { p256dh: '', auth: 'a' } },
      { ...body, platform: 'windows-phone' },
    ]) {
      const res = await request(http())
        .post('/notifications/push/subscribe')
        .send(bad);
      expect(res.status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('DELETE /notifications/push/subscribe removes only the caller’s endpoint', async () => {
    const res = await request(http())
      .delete('/notifications/push/subscribe')
      .send({ endpoint: body.endpoint });
    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'notification.push.unsubscribe' },
      { endpoint: body.endpoint, user_id: '42' },
    ]);
  });

  it('requires authentication', async () => {
    authenticated = false;
    const res = await request(http())
      .post('/notifications/push/subscribe')
      .send(body);
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});
