import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
// RolesGuard ATAYLAB override qilinmaydi — haqiqiy rol tekshiruvi ishlaydi.
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * n0kLbx3d — /notifications/send: `token` maydoni 400 (forbidNonWhitelisted),
 * `requester` notification-service'ga uzatiladi (registrator doirasi u yerda
 * tekshiriladi → 403). Eh8y21Ha — dispatch `type` reyestri gateway'da ham
 * fail-closed; `GET /notifications/types` `:id` dan OLDIN, autentifikatsiya bilan.
 */
describe('NotificationGatewayController — n0kLbx3d / Eh8y21Ha', () => {
  let app: INestApplication;
  const send = jest.fn();
  let user: { sub: string; roles: string[] } | null = {
    sub: '1',
    roles: ['superadmin'],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationGatewayController],
      providers: [{ provide: 'NOTIFICATION', useValue: { send } }, Reflector],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
          };
          return true;
        },
      })
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
  type RpcCall = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => send.mock.calls.at(-1) as RpcCall | undefined;

  beforeEach(() => {
    user = { sub: '1', roles: ['superadmin'] };
    send.mockReset();
    send.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  describe('POST /notifications/send', () => {
    it('TC2: body’da `token` → 400 (forbidNonWhitelisted), RPC chaqirilmaydi', async () => {
      const res = await request(http())
        .post('/notifications/send')
        .send({ group_id: '-1001', message: 'hi', token: '123:ABC' })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('token');
      expect(send).not.toHaveBeenCalled();
    });

    it('TC1: registrator ruxsat etilgan rol, lekin `requester` (roles) uzatiladi — doira notification-service’da (begona guruh → 403)', async () => {
      user = { sub: '77', roles: ['registrator'] };
      await request(http())
        .post('/notifications/send')
        .send({ group_id: '-1001', message: 'hi' })
        .expect(201);
      const [pattern, payload] = lastCall()!;
      expect(pattern).toEqual({ cmd: 'notification.send' });
      expect(payload).toEqual({
        group_id: '-1001',
        message: 'hi',
        requester: { id: '77', roles: ['registrator'] },
      });
    });

    it('courier — 403 (RolesGuard)', async () => {
      user = { sub: '9', roles: ['courier'] };
      await request(http())
        .post('/notifications/send')
        .send({ group_id: '-1001', message: 'hi' })
        .expect(403);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('POST /notifications/dispatch', () => {
    const base = { recipient_id: '42', title: 'Salom' };

    it('TC4: reyestrda yo‘q `type` → 400, xatoda `x.` prefiksi tushuntiriladi', async () => {
      const res = await request(http())
        .post('/notifications/dispatch')
        .send({ ...base, type: 'asdf' })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('x.');
      expect(send).not.toHaveBeenCalled();
    });

    it.each(['order.sold', 'x.test', 'finance.manual'])(
      'TC5: `%s` o‘tadi (katalog / x. / admin formasi)',
      async (type) => {
        await request(http())
          .post('/notifications/dispatch')
          .send({ ...base, type })
          .expect(201);
        expect(lastCall()![0]).toEqual({ cmd: 'notification.dispatch' });
      },
    );

    it('telegram.token → 400; telegram.market_id (frontend shakli) — o‘tadi', async () => {
      await request(http())
        .post('/notifications/dispatch')
        .send({
          ...base,
          type: 'order.sold',
          telegram: { market_id: '5', token: '123:ABC' },
        })
        .expect(400);
      await request(http())
        .post('/notifications/dispatch')
        .send({ ...base, type: 'order.sold', telegram: { market_id: '5' } })
        .expect(201);
      expect(lastCall()![1].telegram).toEqual({ market_id: '5' });
    });
  });

  describe('GET /notifications/types', () => {
    it('TC9: `:id` ga tushmaydi — notification.types.list ga boradi (har qanday autentifikatsiyalangan rol)', async () => {
      user = { sub: '9', roles: ['courier'] };
      await request(http()).get('/notifications/types').expect(200);
      expect(lastCall()).toEqual([{ cmd: 'notification.types.list' }, {}]);
    });

    it('autentifikatsiyasiz — 403', async () => {
      user = null;
      await request(http()).get('/notifications/types').expect(403);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
