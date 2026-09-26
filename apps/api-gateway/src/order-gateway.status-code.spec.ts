import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { OrderGatewayController } from './order-gateway.controller';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';

/**
 * HTTP KODI == JAVOB TANASIDAGI statusCode (order endpointlari).
 *
 * ⚠️ Ilgari qo'shimcha xarajat market tasdig'iga tushganda tanada
 * `statusCode: 202` ("Market tasdig'i kutilmoqda") bo'lsa ham HTTP 201
 * qaytardi — HTTP kodiga qaraydigan mijoz amal bajarildi deb o'ylardi.
 * Test HAQIQIY Nest routeri + global filtrlar orqali o'tadi.
 */
describe('OrderGatewayController — HTTP kodi javob tanasiga mos', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };

  const approvalBody = {
    statusCode: 202,
    message: "Market tasdig'i kutilmoqda",
    data: { approval_required: true, approval: { id: '1', status: 'pending' } },
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
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '24',
            roles: ['courier'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => orderSend.mockReset());

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  it("cancel {extraCost > 0} -> market tasdig'i kutilmoqda: HTTP 202 (201 emas)", async () => {
    orderSend.mockReturnValue(of(approvalBody));

    const res = await request(http())
      .post('/orders/cancel/17')
      .send({ extraCost: 5000, comment: '' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(approvalBody);
  });

  it('sell {extraCost > 0} va partly-sell ham tasdiqqa tushsa HTTP 202', async () => {
    orderSend.mockReturnValue(of(approvalBody));

    const sell = await request(http())
      .post('/orders/sell/17')
      .send({ extraCost: 5000, comment: '' });
    const partly = await request(http())
      .post('/orders/partly-sell/17')
      .send({
        order_item_info: [{ product_id: '4', quantity: 3 }],
        totalPrice: 1500000,
        extraCost: 5000,
      });

    expect(sell.status).toBe(202);
    expect(partly.status).toBe(202);
  });

  it('cancel {extraCost: 0} -> odatiy javob kodi tanadagidek (regressiya)', async () => {
    orderSend.mockReturnValue(
      of({ statusCode: 200, message: 'Order cancelled', data: {} }),
    );

    const res = await request(http())
      .post('/orders/cancel/17')
      .send({ extraCost: 0, comment: '' });

    expect(res.status).toBe(200);
    expect((res.body as { statusCode: number }).statusCode).toBe(200);
  });

  it("mavjud bo'lmagan buyurtma -> HTTP 404, tanadagi kod bilan bir xil", async () => {
    // Haqiqiy ClientProxy mikroservis xatosini oddiy obyekt sifatida uzatadi.
    orderSend.mockReturnValue(
      throwError(() => ({ statusCode: 404, message: 'Order not found' })),
    );

    const res = await request(http())
      .post('/orders/cancel/999999')
      .send({ extraCost: 0, comment: '' });

    expect(res.status).toBe(404);
    expect((res.body as { statusCode: number }).statusCode).toBe(404);
  });

  it('kontrakt: interceptor butun kontrollerga (barcha order endpointlariga) ulangan', () => {
    const interceptors =
      (Reflect.getMetadata('__interceptors__', OrderGatewayController) as
        | unknown[]
        | undefined) ?? [];
    expect(interceptors).toContain(BodyStatusCodeInterceptor);
  });

  it("tanada statusCode bo'lmasa NestJS kodi o'zgarmaydi", async () => {
    orderSend.mockReturnValue(of({ data: { id: '17' } }));

    const res = await request(http())
      .post('/orders/cancel/17')
      .send({ extraCost: 0, comment: '' });

    expect(res.status).toBe(201);
  });
});
