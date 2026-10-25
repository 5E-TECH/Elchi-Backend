import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * Z1c1sNPT — `POST /district/:id/merge` 409/503 javobida qaytarilgan sonlar
 * `data.details` ichida TEKIS maydonlar bo'lib FE'ga yetadi:
 * `rolled_back_orders`, `rolled_back_users`, `rolled_back_branches` (+
 * `manual_fix` da `stranded_order_ids`). Ildizdagi `data.rolled_back`
 * (ichma-ich obyekt) va `stranded[].ids` gateway filtridan O'TMAYDI — shuning
 * uchun tekis. Servis xatosi RMQ orqali oddiy obyekt bo'lib keladi (prod'dagi
 * kabi) va global filtrlar (main.ts bilan bir xil) javobni quradi.
 */
describe('Z1c1sNPT — district merge xatosi: data.details.rolled_back_* (gateway)', () => {
  let app: INestApplication;
  let rpcError: unknown;
  const logisticsSend = jest.fn(() => throwError(() => rpcError));
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles: ['admin'],
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => logisticsSend.mockClear());

  it('⭐ 409 (kompensatsiya OK) — data.details da buyurtmalar/foydalanuvchilar/filiallar soni', async () => {
    rpcError = {
      statusCode: 409,
      message:
        "Birlashtirish bekor qilindi: servis rad etdi. Ko'chirilganlar A tumanga (#173) qaytarildi, tuman o'chirilmadi — qayta urinib ko'ring.",
      data: {
        from_district_id: '173',
        to_district_id: '28',
        rolled_back: { orders: 128, users: 2 },
        reason: 'remote_refused',
        details: {
          reason: 'remote_refused',
          kind: 'branches',
          from_district_id: '173',
          to_district_id: '28',
          rolled_back_orders: 128,
          rolled_back_users: 2,
          rolled_back_branches: 0,
          manual_fix: false,
        },
      },
    };
    const res = await request(http())
      .post('/district/173/merge')
      .send({ target_district_id: '28' })
      .expect(409);
    const body = res.body as {
      data: { reason: string; details: Record<string, unknown> };
    };
    expect(body.data.reason).toBe('remote_refused');
    expect(body.data.details).toEqual(
      expect.objectContaining({
        rolled_back_orders: 128,
        rolled_back_users: 2,
        rolled_back_branches: 0,
        manual_fix: false,
      }),
    );
    // Ichma-ich `rolled_back` (ildizda ham) FE'ga chiqmaydi.
    expect(body.data).not.toHaveProperty('rolled_back');
    expect(logisticsSend).toHaveBeenCalledWith(
      { cmd: 'logistics.district.merge' },
      { id: '173', target_district_id: '28' },
    );
  });

  it('⭐ 503 + manual_fix — sonlar, stranded (ID’siz) va stranded_order_ids (≤10) o‘tadi; to‘liq ids o‘tmaydi', async () => {
    rpcError = {
      statusCode: 503,
      message:
        "Birlashtirish bekor qilindi: javob kelmadi. DIQQAT — kompensatsiya to'liq bo'lmadi, QO'LDA TUZATING: …",
      data: {
        from_district_id: '173',
        to_district_id: '28',
        rolled_back: { orders: 0, users: 1 },
        stranded: [
          {
            kind: 'orders',
            district_id: '28',
            ids: ['7001', '7002', '7003'],
            reason: 'A ga qaytarib bo‘lmadi: javob kelmadi (timeout)',
          },
        ],
        reason: 'timeout',
        details: {
          reason: 'timeout',
          kind: 'branches',
          timeout_ms: 15000,
          from_district_id: '173',
          to_district_id: '28',
          rolled_back_orders: 0,
          rolled_back_users: 1,
          rolled_back_branches: 0,
          manual_fix: true,
          stranded: [{ kind: 'orders', district_id: '28', count: 3 }],
          stranded_order_ids: ['7001', '7002', '7003'],
        },
      },
    };
    const res = await request(http())
      .post('/district/173/merge')
      .send({ target_district_id: '28' })
      .expect(503);
    const details = (res.body as { data: { details: Record<string, unknown> } })
      .data.details;
    expect(details).toEqual(
      expect.objectContaining({
        rolled_back_orders: 0,
        rolled_back_users: 1,
        rolled_back_branches: 0,
        manual_fix: true,
        stranded: [{ kind: 'orders', district_id: '28', count: 3 }],
        stranded_order_ids: ['7001', '7002', '7003'],
      }),
    );
    expect(res.body).not.toHaveProperty('data.stranded');
  });
});
