import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * MARSHRUT TARTIBI (PINtZcLj) — `GET /orders/extra-cost-approvals`
 * `@Get(':id')` dan OLDIN bo'lishi shart. Ilgari so'rov buyurtma-ID
 * handleriga tushib 400 qaytarardi va market kuryerning qo'shimcha xarajat
 * so'rovini hech qachon ko'rmasdi. Tekshiruv HAQIQIY Nest routeri orqali.
 */
describe('OrderGatewayController — marshrut tartibi (PINtZcLj)', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };
  let user: { sub: string; roles: string[] } = {
    sub: '1',
    roles: ['superadmin'],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    orderSend.mockReset();
    orderSend.mockReturnValue(of({ statusCode: 200, data: [] }));
    user = { sub: '1', roles: ['superadmin'] };
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const cmds = () =>
    orderSend.mock.calls.map((c: [{ cmd: string }, unknown]) => c[0].cmd);

  it('⭐ TC1: superadmin GET /orders/extra-cost-approvals?status=pending → 200 va massiv, :id ga TUSHMAYDI', async () => {
    const res = await request(http()).get(
      '/orders/extra-cost-approvals?status=pending',
    );

    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { data: unknown }).data)).toBe(true);
    expect(cmds()).toEqual(['order.extra_cost_approval.list']);
    expect(orderSend.mock.calls[0][1]).toEqual(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('⭐ TC2: market so`rovi requester sifatida uzatiladi (ko`lam order-service da: where.market_id = requester.id)', async () => {
    user = { sub: '16', roles: ['market'] };
    await request(http()).get('/orders/extra-cost-approvals');

    expect(orderSend.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        requester: expect.objectContaining({ id: '16', roles: ['market'] }),
      }),
    );
  });

  it('GET /orders/5 hamon buyurtma-ID handleriga boradi (regressiya emas)', async () => {
    await request(http()).get('/orders/5');
    expect(cmds()).not.toContain('order.extra_cost_approval.list');
  });

  it('⭐ har bir statik bir segmentli GET `:id` dan OLDIN e`lon qilingan', () => {
    const proto = OrderGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    const gets = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata('path', proto[name]) as string | undefined,
        method: Reflect.getMetadata('method', proto[name]) as
          | number
          | undefined,
      }))
      // RequestMethod.GET === 0
      .filter((r) => r.method === 0 && typeof r.path === 'string');

    const idIndex = gets.findIndex((r) => r.path === ':id');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    const staticAfterId = gets
      .slice(idIndex + 1)
      .filter((r) => /^[^/:]+$/.test(r.path!));
    expect(staticAfterId).toEqual([]);
  });
});
