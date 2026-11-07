import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter, Roles as RoleEnum } from '@app/common';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * Skaner bilan qabul (2026-11-07) — `ReceivePostScanRequestDto` (`scan`)
 * FAQAT `PATCH post/receive/:id` da. `post/cancel` va
 * `post/cancel/receive/:id` eski `ReceivePostRequestDto` da: `scan` u yerda
 * 400 (forbidNonWhitelisted), logistics chaqirilmaydi.
 *
 * HAQIQIY Nest routeri + RolesGuard + gateway global ValidationPipe
 * opsiyalari; faqat JwtAuthGuard almashtiriladi.
 */
describe('PATCH post/receive/:id — scan (gateway DTO)', () => {
  let app: INestApplication;
  const scanResponse = {
    statusCode: 200,
    message: 'Buyurtma qabul qilindi',
    data: [{ id: '101', status: 'waiting', market_id: '5' }],
    failures: [],
    not_received_order_ids: [],
    received_order_ids: ['101'],
    already_received_order_ids: [],
    remaining_count: 2,
    post_status: 'sent',
  };
  const logisticsSend = jest.fn(() => of(scanResponse));
  let user: { sub: string; roles: string[]; branch_id?: string | null } = {
    sub: '44',
    roles: [RoleEnum.COURIER],
    branch_id: '10',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn(() => of({})) } },
        { provide: 'ORDER', useValue: { send: jest.fn(() => of({})) } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
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
    app.useGlobalInterceptors(new BodyStatusCodeInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    logisticsSend.mockClear();
    user = { sub: '44', roles: [RoleEnum.COURIER], branch_id: '10' };
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('⭐ scan: true — logistics.post.receive ga `scan: true` bilan boradi, skan maydonlari javobda qoladi', async () => {
    const res = await request(http())
      .patch('/post/receive/40')
      .send({ order_ids: ['101'], scan: true });

    expect(res.status).toBe(200);
    expect(logisticsSend).toHaveBeenCalledWith(
      { cmd: 'logistics.post.receive' },
      {
        id: '40',
        dto: { order_ids: ['101'], scan: true },
        requester: { id: '44', roles: [RoleEnum.COURIER], branch_id: '10' },
      },
    );
    expect(res.body).toMatchObject({
      received_order_ids: ['101'],
      already_received_order_ids: [],
      not_received_order_ids: [],
      remaining_count: 2,
      post_status: 'sent',
    });
  });

  it('scan berilmasa — dto avvalgidek (faqat order_ids)', async () => {
    const res = await request(http())
      .patch('/post/receive/40')
      .send({ order_ids: ['101', '102'] });

    expect(res.status).toBe(200);
    const [, payload] = logisticsSend.mock.calls[0] as unknown as [
      unknown,
      { dto: Record<string, unknown> },
    ];
    expect(payload.dto).toEqual({ order_ids: ['101', '102'] });
  });

  it('scan boolean emas — 400, logistics chaqirilmaydi', async () => {
    const res = await request(http())
      .patch('/post/receive/40')
      .send({ order_ids: ['101'], scan: 'yes' });

    expect(res.status).toBe(400);
    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it('⭐ POST post/cancel — `scan` ruxsat etilmagan (400 forbidNonWhitelisted)', async () => {
    const res = await request(http())
      .post('/post/cancel')
      .send({ order_ids: ['101'], scan: true });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('scan');
    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it('⭐ POST post/cancel/receive/:id — `scan` ruxsat etilmagan (400 forbidNonWhitelisted)', async () => {
    user = { sub: '198', roles: [RoleEnum.MANAGER], branch_id: '10' };
    const res = await request(http())
      .post('/post/cancel/receive/40')
      .send({ order_ids: ['101'], scan: true });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('scan');
    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it('POST post/cancel/receive/:id — eski tana avvalgidek o‘tadi', async () => {
    user = { sub: '198', roles: [RoleEnum.MANAGER], branch_id: '10' };
    const res = await request(http())
      .post('/post/cancel/receive/40')
      .send({ order_ids: ['101'] });

    expect(res.status).not.toBe(400);
    expect(logisticsSend).toHaveBeenCalledWith(
      { cmd: 'logistics.post.cancel.receive' },
      expect.objectContaining({ dto: { order_ids: ['101'] } }),
    );
  });
});
