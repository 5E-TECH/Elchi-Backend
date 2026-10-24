import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { NotificationGatewayController } from './notification-gateway.controller';

/**
 * (KJNHAlGW) GET /notifications/me/telegram-groups — faqat MARKET va
 * MARKET_OPERATOR; market_id FAQAT tokendan (query'dagisi uzatilmaydi);
 * `:id` marshruti uni ushlab qolmaydi.
 */
describe('KJNHAlGW — GET /notifications/me/telegram-groups (gateway)', () => {
  let app: INestApplication;
  const notificationSend = jest.fn();
  let user: { sub: string; roles: string[] } | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationGatewayController],
      providers: [
        { provide: 'NOTIFICATION', useValue: { send: notificationSend } },
        Reflector,
      ],
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
    await app.init();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    notificationSend.mockReset();
    notificationSend.mockReturnValue(
      of({ statusCode: 200, message: 'ok', data: [] }),
    );
  });

  it.each([
    ['market', '37'],
    ['market_operator', '501'],
  ])(
    '%s → 200; requester faqat JWT dan, query market_id uzatilmaydi',
    async (role, sub) => {
      user = { sub, roles: [role] };
      const res = await request(http())
        .get('/notifications/me/telegram-groups?market_id=999')
        .expect(200);
      expect((res.body as { data: unknown }).data).toEqual([]);
      expect(notificationSend).toHaveBeenCalledTimes(1);
      const [pattern, payload] = (
        notificationSend.mock.calls as unknown[][]
      )[0];
      expect(pattern).toEqual({ cmd: 'notification.telegram.my_groups' });
      expect(payload).toEqual({ requester: { id: sub, roles: [role] } });
      expect(JSON.stringify(payload)).not.toContain('999');
    },
  );

  it.each(['admin', 'superadmin', 'courier', 'customer'])(
    '%s → 403, servisga so‘rov yo‘q',
    async (role) => {
      user = { sub: '25', roles: [role] };
      await request(http())
        .get('/notifications/me/telegram-groups')
        .expect(403);
      expect(notificationSend).not.toHaveBeenCalled();
    },
  );
});
