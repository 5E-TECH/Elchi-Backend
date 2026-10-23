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
// RolesGuard ATAYLAB override qilinmaydi — haqiqiy rol tekshiruvi.
import { TelegramGatewayController } from './telegram-gateway.controller';

/**
 * (2crjWf7v) «Yetkazish metrikasi: kvitansiya yuborilgan/yetgan nisbati
 * dashboardda ko'rinadi» — backend HTTP endpointi `GET /telegram/dm-delivery`:
 * faqat superadmin, faqat o'qish (GET), so'rov parametrlari validatsiyadan
 * o'tadi va notification-service'ga `notification.telegram.dm_delivery`.
 */
describe('2crjWf7v — GET /telegram/dm-delivery (gateway)', () => {
  let app: INestApplication;
  const notificationSend = jest.fn();
  const identitySend = jest.fn(() => of({}));
  let user: { sub: string; roles: string[] } | null = null;

  const REPORT = {
    statusCode: 200,
    message: 'success',
    data: {
      type: 'finance.payment_received',
      from: '2026-09-23T19:00:00.000Z',
      to: '2026-10-23T19:00:00.000Z',
      totals: {
        total: 4,
        sent: 2,
        failed: 1,
        pending: 0,
        skipped: 1,
        no_provider: 0,
        other: 0,
        delivery_ratio: 0.667,
        reach_ratio: 0.5,
      },
      skipped_reasons: { no_telegram_id: 1 },
      by_role: [],
      days: [],
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelegramGatewayController],
      providers: [
        { provide: 'NOTIFICATION', useValue: { send: notificationSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
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
  const lastCall = () => notificationSend.mock.calls.at(-1) as RpcCall;

  beforeEach(() => {
    user = { sub: '1', roles: ['superadmin'] };
    notificationSend.mockReset();
    notificationSend.mockReturnValue(of(REPORT));
  });

  it("superadmin → 200, javob notification-service'dan o'zgarishsiz", async () => {
    const res = await request(http())
      .get('/telegram/dm-delivery')
      .query({ from: '2026-10-01', to: '2026-10-23' })
      .expect(200);

    expect(res.body).toEqual(REPORT);
    expect(notificationSend).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual([
      { cmd: 'notification.telegram.dm_delivery' },
      { from: '2026-10-01', to: '2026-10-23', type: undefined },
    ]);
  });

  it("`type` — ruxsat etilgan DM turi o'tkaziladi", async () => {
    await request(http())
      .get('/telegram/dm-delivery')
      .query({ type: 'finance.cash_reminder' })
      .expect(200);
    expect(lastCall()[1]).toMatchObject({ type: 'finance.cash_reminder' });
  });

  it.each(['admin', 'manager', 'courier', 'market', 'registrator'])(
    'superadmin emas (%s) → 403, servisga so‘rov ketmaydi',
    async (role) => {
      user = { sub: '2', roles: [role] };
      await request(http()).get('/telegram/dm-delivery').expect(403);
      expect(notificationSend).not.toHaveBeenCalled();
    },
  );

  it('JWT yo‘q → rad etiladi, servisga so‘rov ketmaydi', async () => {
    user = null;
    const res = await request(http()).get('/telegram/dm-delivery');
    expect([401, 403]).toContain(res.status);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'order.sold' }],
    [{ type: 'finance.balance_topup' }],
    [{ from: 'kecha' }],
    [{ to: '2026-13-45' }],
    [{ user_id: '5' }],
  ])('noto‘g‘ri so‘rov %j → 400', async (query) => {
    await request(http()).get('/telegram/dm-delivery').query(query).expect(400);
    expect(notificationSend).not.toHaveBeenCalled();
  });

  it("faqat o'qish: POST/PATCH/DELETE marshruti yo'q", async () => {
    await request(http()).post('/telegram/dm-delivery').expect(404);
    await request(http()).patch('/telegram/dm-delivery').expect(404);
    await request(http()).delete('/telegram/dm-delivery').expect(404);
    expect(notificationSend).not.toHaveBeenCalled();
  });
});
