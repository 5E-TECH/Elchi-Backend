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

  describe('audit 2026-11-22 #9 — barcha sotuvlar sahifalab', () => {
    const page = (
      items: Array<Record<string, unknown>>,
      extra: Record<string, unknown>,
    ) => of({ items, cursor: 'id_asc', ...extra });
    const P1 = [
      { order_id: '7001', total_price: 100000, market_id: '12' },
      { order_id: '7002', total_price: 100000, market_id: '12' },
    ];
    const P2 = [{ order_id: '7009', total_price: 40000, market_id: '12' }];
    const backfill = (data: Record<string, unknown>) =>
      of({ statusCode: 200, message: 'ok', data });

    it('⭐ truncated → keyingi sahifa after_id bilan; finance har sahifaga, natija yig`iladi', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      order.send
        .mockReturnValueOnce(
          page(P1, { truncated: true, next_after_id: '7002' }),
        )
        .mockReturnValueOnce(
          page(P2, { truncated: false, next_after_id: null }),
        );
      finance.send
        .mockReturnValueOnce(
          backfill({
            sold_orders: 2,
            already_recorded: 1,
            missing: 1,
            to_record: 1,
            amount: 5000.1,
            commission_type: 'percent',
            commission_value: 5,
            created: 0,
          }),
        )
        .mockReturnValueOnce(
          backfill({
            sold_orders: 1,
            already_recorded: 0,
            missing: 1,
            to_record: 1,
            amount: 2000.2,
            commission_type: 'percent',
            commission_value: 5,
            created: 0,
          }),
        );
      const res = await request(http())
        .get('/finance/operator-payments/missing-earnings?operator_id=41')
        .set(as(['market']))
        .expect(200);

      expect(order.send.mock.calls.map((call) => call[1])).toEqual([
        { market_id: '12', operator_id: '41' },
        { market_id: '12', operator_id: '41', after_id: '7002' },
      ]);
      expect(
        finance.send.mock.calls.map((call) => call[1].orders as unknown[]),
      ).toEqual([P1, P2]);
      expect(res.body.data).toEqual({
        operator_id: '41',
        sold_orders: 3,
        already_recorded: 1,
        missing: 2,
        commission_type: 'percent',
        commission_value: 5,
        to_record: 2,
        amount: 7000.3,
        created: 0,
        dry_run: true,
        operator_name: 'Sevinch Karimova',
        truncated: false,
      });
    });

    it('eski order-service (cursor yo`q) — bitta sahifa, aylanib qolmaydi, truncated: true', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      order.send.mockReturnValue(of({ items: P1, truncated: true }));
      const res = await request(http())
        .get('/finance/operator-payments/missing-earnings?operator_id=41')
        .set(as(['market']))
        .expect(200);
      expect(order.send).toHaveBeenCalledTimes(1);
      expect(finance.send).toHaveBeenCalledTimes(1);
      expect(res.body.data.truncated).toBe(true);
    });

    it('next_after_id o`smasa — to`xtaydi (himoya)', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      order.send.mockReturnValue(
        page(P1, { truncated: true, next_after_id: '7002' }),
      );
      const res = await request(http())
        .get('/finance/operator-payments/missing-earnings?operator_id=41')
        .set(as(['market']))
        .expect(200);
      // 1-sahifa → after_id 7002; 2-sahifa yana 7002 ni beradi → to'xtaydi.
      expect(order.send).toHaveBeenCalledTimes(2);
      expect(res.body.data.truncated).toBe(true);
    });
  });

  describe('audit 2026-11-22 #8 — yozilganlar sotuvdan chiqqan bo`lsa ulush olib tashlanadi', () => {
    const route = (recheck: () => unknown) => {
      order.send.mockImplementation((_pattern, payload) =>
        payload.order_ids
          ? recheck()
          : of({ items: SOLD, truncated: false, cursor: 'id_asc' }),
      );
      finance.send.mockImplementation((pattern) =>
        pattern.cmd === 'finance.operator.earning.backfill'
          ? of({
              statusCode: 200,
              data: {
                sold_orders: 2,
                missing: 2,
                to_record: 2,
                amount: 12500,
                created: 2,
                created_amount: 12500,
                created_order_ids: ['7003', '7004'],
              },
            })
          : of({ statusCode: 200, data: null }),
      );
    };
    const removes = () =>
      finance.send.mock.calls
        .filter((call) => call[0].cmd === 'finance.operator.earning.remove')
        .map((call) => call[1]);

    it('⭐ qayta tekshiruv: 7004 endi sotilmagan → faqat uning ulushi o`chiriladi, `revoked: 1`', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      route(() =>
        of({
          items: [SOLD[0]],
          truncated: false,
          cursor: 'id_asc',
          filtered_by_ids: true,
        }),
      );
      const res = await request(http())
        .post('/finance/operator-payments/missing-earnings')
        .set(as(['market']))
        .send({ operator_id: '41' })
        .expect(200);
      expect(order.send).toHaveBeenCalledWith(
        { cmd: 'order.operator.sold_orders' },
        { market_id: '12', operator_id: '41', order_ids: ['7003', '7004'] },
      );
      expect(removes()).toEqual([{ order_id: '7004' }]);
      expect(res.body.data).toMatchObject({
        created: 2,
        created_amount: 12500,
        revoked: 1,
        dry_run: false,
      });
      // Ichki ro'yxat HTTP javobiga chiqmaydi.
      expect(res.body.data.created_order_ids).toBeUndefined();
    });

    it('eski order-service (`filtered_by_ids` yo`q) — hech narsa o`chirilmaydi', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      route(() => of({ items: [], truncated: false }));
      const res = await request(http())
        .post('/finance/operator-payments/missing-earnings')
        .set(as(['market']))
        .send({ operator_id: '41' })
        .expect(200);
      expect(removes()).toEqual([]);
      expect(res.body.data.revoked).toBe(0);
    });

    it('qayta tekshiruv ishlamasa — javob baribir 200, o`chirish yo`q', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      route(() => throwError(() => new Error('order-service down')));
      const res = await request(http())
        .post('/finance/operator-payments/missing-earnings')
        .set(as(['market']))
        .send({ operator_id: '41' })
        .expect(200);
      expect(removes()).toEqual([]);
      expect(res.body.data).toMatchObject({ created: 2, revoked: 0 });
    });

    it('GET (dry_run) — qayta tekshiruv ham, o`chirish ham yo`q', async () => {
      identity.send.mockReturnValueOnce(operatorUser());
      route(() => of({ items: [], filtered_by_ids: true }));
      await request(http())
        .get('/finance/operator-payments/missing-earnings?operator_id=41')
        .set(as(['market']))
        .expect(200);
      expect(order.send).toHaveBeenCalledTimes(1);
      expect(removes()).toEqual([]);
    });
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
