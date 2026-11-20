import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OperatorEarningBackfillGatewayController } from './operator-earning-backfill-gateway.controller';

/**
 * 2026-11-20 — `finance/operator-payments/missing-earnings` (faqat MARKET):
 * operator — shu marketning o'chirilmagan market operatori (identity
 * `find_by_id`), aks holda 404 va boshqa xizmatlar chaqirilmaydi; buyurtmalar
 * — order-service (shu market, shu operator); finance — `dry_run` (GET) /
 * yozish (POST).
 */
describe('finance/operator-payments/missing-earnings gateway', () => {
  let app: INestApplication;
  type Call = [{ cmd: string }, Record<string, unknown>];
  const finance = { send: jest.fn<unknown, Call>() };
  const identity = { send: jest.fn<unknown, Call>() };
  const order = { send: jest.fn<unknown, Call>() };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roles: string[], sub = '12') => ({
    'x-test-user': JSON.stringify({ sub, roles }),
  });
  const SOLD = [
    { order_id: '7003', total_price: 200000, market_id: '12' },
    { order_id: '7004', total_price: 50000, market_id: '12' },
  ];
  const operatorUser = (extra: Record<string, unknown> = {}) =>
    of({
      statusCode: 200,
      data: {
        id: '41',
        role: 'market_operator',
        market_id: '12',
        name: 'Sevinch Karimova',
        ...extra,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OperatorEarningBackfillGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: identity },
        { provide: 'ORDER', useValue: order },
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
  beforeEach(() => {
    jest.clearAllMocks();
    order.send.mockReturnValue(of({ items: SOLD, truncated: false }));
    finance.send.mockReturnValue(
      of({
        statusCode: 200,
        message: 'ok',
        data: { missing: 2, to_record: 2, amount: 12500, created: 0 },
      }),
    );
  });

  it('GET — oldindan ko`rish: operator tekshiriladi, buyurtmalar order-service`dan, finance dry_run', async () => {
    identity.send.mockReturnValueOnce(operatorUser());
    const res = await request(http())
      .get('/finance/operator-payments/missing-earnings?operator_id=41')
      .set(as(['market']))
      .expect(200);

    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '41' },
    );
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.operator.sold_orders' },
      { market_id: '12', operator_id: '41' },
    );
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.earning.backfill' },
      {
        operator_id: '41',
        orders: SOLD,
        dry_run: true,
        requested_by: { id: '12', role: 'market' },
      },
    );
    expect(res.body.data).toMatchObject({
      to_record: 2,
      amount: 12500,
      operator_name: 'Sevinch Karimova',
      truncated: false,
    });
  });

  it('POST — yozish (dry_run: false)', async () => {
    identity.send.mockReturnValueOnce(operatorUser());
    await request(http())
      .post('/finance/operator-payments/missing-earnings')
      .set(as(['market']))
      .send({ operator_id: '41' })
      .expect(200);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.earning.backfill' },
      expect.objectContaining({ operator_id: '41', dry_run: false }),
    );
  });

  it('begona market operatori / boshqa rol / topilmadi — 404, order va finance chaqirilmaydi', async () => {
    for (const reply of [
      operatorUser({ market_id: '99' }),
      operatorUser({ role: 'courier' }),
      throwError(() => new Error('User topilmadi')),
    ]) {
      identity.send.mockReturnValueOnce(reply);
      await request(http())
        .post('/finance/operator-payments/missing-earnings')
        .set(as(['market']))
        .send({ operator_id: '41' })
        .expect(404);
    }
    expect(order.send).not.toHaveBeenCalled();
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('market emas — 403; operator_id yo`q / noto`g`ri / ortiqcha maydon — 400', async () => {
    await request(http())
      .get('/finance/operator-payments/missing-earnings?operator_id=41')
      .set(as(['superadmin'], '1'))
      .expect(403);
    await request(http())
      .get('/finance/operator-payments/missing-earnings')
      .set(as(['market']))
      .expect(400);
    await request(http())
      .post('/finance/operator-payments/missing-earnings')
      .set(as(['market']))
      .send({ operator_id: '0' })
      .expect(400);
    await request(http())
      .post('/finance/operator-payments/missing-earnings')
      .set(as(['market']))
      .send({ operator_id: '41', market_id: '99' })
      .expect(400);
    expect(identity.send).not.toHaveBeenCalled();
  });
});
