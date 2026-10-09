import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import {
  OrderGatewayController,
  SETTLEMENT_LUMP_SUM_GONE_MESSAGE,
} from './order-gateway.controller';

/**
 * MlVMpsfr — lump-sum settlement oyoqlari (Faza 2b) o'chirilgan. Ilgari
 * marshrutlar ochiq turib, order-service 400 qaytarardi (5hBeDuyn dagi
 * idempotentlik kaliti endi ma'nosiz). Endi gateway aniq 410 Gone beradi,
 * xabarda haqiqiy pul yo'li ko'rsatiladi va order-service chaqirilmaydi.
 * Body validatsiyasi ham yo'q — `branch_id` kabi eski maydon 400 emas, 410.
 */
describe('POST /orders/settlement/* — 410 Gone (MlVMpsfr)', () => {
  let app: INestApplication;
  const orderSend = jest.fn(() => of({ statusCode: 200 }));
  const noop = { send: jest.fn(() => of({})) };

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
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles: ['superadmin'],
          };
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

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it.each([
    ['courier-to-branch', { courier_id: '56', branch_id: '12', amount: 500 }],
    ['branch-to-hq', { branch_id: '12', amount: 1000 }],
    ['hq-to-market', { market_id: '3', amount: 500 }],
  ])(
    '⭐ TC2: POST /orders/settlement/%s → 410, order-service chaqirilmaydi',
    async (leg, body) => {
      orderSend.mockClear();
      const res = await request(http())
        .post(`/orders/settlement/${leg}`)
        .send(body);

      expect(res.status).toBe(410);
      expect((res.body as { message: string }).message).toBe(
        SETTLEMENT_LUMP_SUM_GONE_MESSAGE,
      );
      expect(orderSend).not.toHaveBeenCalled();
    },
  );

  it('xabar haqiqiy pul yo`lini (kassa to`lovlari) ko`rsatadi', () => {
    expect(SETTLEMENT_LUMP_SUM_GONE_MESSAGE).toMatch(
      /finance\/cashbox\/payment\/courier/,
    );
    expect(SETTLEMENT_LUMP_SUM_GONE_MESSAGE).toMatch(/branch-to-main/);
    expect(SETTLEMENT_LUMP_SUM_GONE_MESSAGE).toMatch(/payment\/market/);
  });
});
