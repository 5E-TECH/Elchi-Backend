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
import { MarketOperatorOrdersGatewayController } from './market-operator-orders-gateway.controller';

/**
 * 2026-11-20 — `market-operators/unlinked-orders` (faqat MARKET): operator ismi
 * faqat matn bo'lib qolgan eski buyurtmalar ro'yxati va ommaviy biriktirish.
 * Market — JWT `sub`; operator — shu marketning faol operatori (bir marta,
 * `identity.market_operator.selectable`), aks holda 400 va order-service
 * chaqirilmaydi.
 */
describe('market-operators/unlinked-orders gateway', () => {
  let app: INestApplication;
  type Call = [{ cmd: string }, Record<string, unknown>];
  const order = { send: jest.fn<unknown, Call>() };
  const identity = { send: jest.fn<unknown, Call>() };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roles: string[], sub = '12') => ({
    'x-test-user': JSON.stringify({ sub, roles }),
  });
  const selectable = (items: Array<{ id: string; name: string }>) =>
    of({ statusCode: 200, data: { items } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MarketOperatorOrdersGatewayController],
      providers: [
        { provide: 'ORDER', useValue: order },
        { provide: 'IDENTITY', useValue: identity },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = JSON.parse(String(req.headers['x-test-user'] ?? 'null'));
          return Boolean(req.user);
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
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('GET — market_id faqat JWT dan; boshqa rol 403', async () => {
    order.send.mockReturnValueOnce(
      of({ statusCode: 200, data: { groups: [], total_orders: 0 } }),
    );
    const res = await request(http())
      .get('/market-operators/unlinked-orders')
      .set(as(['market']))
      .expect(200);
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.operator.unlinked' },
      { market_id: '12' },
    );
    expect(res.body.data).toEqual({ groups: [], total_orders: 0 });

    await request(http())
      .get('/market-operators/unlinked-orders')
      .set(as(['superadmin'], '1'))
      .expect(403);
    await request(http())
      .get('/market-operators/unlinked-orders')
      .set(as(['market_operator'], '42'))
      .expect(403);
  });

  it('POST assign — operator bir marta tekshiriladi, order-service`ga tekshirilgan ism va market doirasi bilan', async () => {
    identity.send.mockReturnValueOnce(
      selectable([{ id: '41', name: 'Sevinch Karimova' }]),
    );
    order.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        data: { assigned: 2, failed: 0, earnings_recorded: 1, results: [] },
      }),
    );

    const res = await request(http())
      .post('/market-operators/unlinked-orders/assign')
      .set(as(['market']))
      .send({ operator_id: '41', order_ids: ['55120', '55121'] })
      .expect(200);

    expect(identity.send).toHaveBeenCalledTimes(1);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.market_operator.selectable' },
      { market_id: '12', operator_id: '41' },
    );
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.operator.assign_bulk' },
      {
        order_ids: ['55120', '55121'],
        operator_id: '41',
        operator_name: 'Sevinch Karimova',
        market_id: '12',
        requester: { id: '12', roles: ['market'], market_id: '12' },
      },
    );
    expect(res.body.data).toMatchObject({ assigned: 2, earnings_recorded: 1 });
  });

  it('POST assign — begona / nofaol operator 400, order-service chaqirilmaydi', async () => {
    identity.send.mockReturnValueOnce(selectable([]));
    const res = await request(http())
      .post('/market-operators/unlinked-orders/assign')
      .set(as(['market']))
      .send({ operator_id: '77', order_ids: ['55120'] })
      .expect(400);
    expect(res.body.code).toBe('CHOSEN_OPERATOR_NOT_SELECTABLE');
    expect(order.send).not.toHaveBeenCalled();
  });

  it('POST assign — tana tekshiruvi: bo`sh, 100 dan ko`p, noto`g`ri id, market_id tanada — 400', async () => {
    const post = (body: unknown) =>
      request(http())
        .post('/market-operators/unlinked-orders/assign')
        .set(as(['market']))
        .send(body as object);
    await post({ operator_id: '41', order_ids: [] }).expect(400);
    await post({
      operator_id: '41',
      order_ids: Array.from({ length: 101 }, (_, i) => String(1000 + i)),
    }).expect(400);
    await post({ operator_id: '41', order_ids: ['abc'] }).expect(400);
    await post({ operator_id: '0', order_ids: ['1'] }).expect(400);
    await post({
      operator_id: '41',
      order_ids: ['1'],
      market_id: '99',
    }).expect(400);
    expect(identity.send).not.toHaveBeenCalled();
    expect(order.send).not.toHaveBeenCalled();
  });
});
