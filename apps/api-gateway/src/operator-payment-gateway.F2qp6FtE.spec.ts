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
import { FinanceGatewayController } from './finance-gateway.controller';
import { OperatorPaymentGatewayController } from './operator-payment-gateway.controller';

/**
 * F2qp6FtE — `/finance/operator-payments` (faqat MARKET): HAQIQIY RolesGuard +
 * main.ts dagi ValidationPipe. Market id — FAQAT JWT `sub`; operator — shu
 * marketning operatori (identity `find_by_market`), aks holda 404; yozuv
 * finance'ga `finance.operator.market_payment.*` bilan ketadi (kassasiz).
 */
describe('F2qp6FtE — /finance/operator-payments gateway', () => {
  let app: INestApplication;
  type Call = [{ cmd: string }, Record<string, unknown>];
  const finance = {
    send: jest.fn<unknown, Call>(() =>
      of({
        statusCode: 201,
        message: 'ok',
        data: { id: '301', operator_id: '41' },
      }),
    ),
  };
  const identity = {
    send: jest.fn<unknown, Call>(() =>
      of({
        statusCode: 200,
        data: {
          items: [
            { id: '41', name: 'Madina Xoliqova', status: 'active' },
            { id: '43', name: 'Kamola Rasulova', status: 'inactive' },
          ],
          meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
        },
      }),
    ),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roles: string[], sub = '12') => ({
    'x-test-user': JSON.stringify({ sub, roles }),
  });
  const financeCalls = (cmd: string) =>
    finance.send.mock.calls.filter(([pattern]) => pattern.cmd === cmd);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OperatorPaymentGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: identity },
        // 2026-11-20: hisobdagi buyurtmalar soni (alohida spec'da tekshiriladi).
        {
          provide: 'ORDER',
          useValue: { send: jest.fn(() => of({ items: [] })) },
        },
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

  describe('POST /finance/operator-payments', () => {
    const BODY = {
      operator_id: '41',
      amount: 150000,
      paid_at: '2026-11-17',
      note: 'Oktabr',
    };

    it('market: o`z operatoriga — finance`ga JWT market_id bilan, kassasiz yozuv buyrug`i', async () => {
      const res = await request(http())
        .post('/finance/operator-payments')
        .set(as(['market']))
        .set('Idempotency-Key', ' op-key-1 ')
        .send(BODY)
        .expect(201);

      expect(identity.send).toHaveBeenCalledWith(
        { cmd: 'identity.market_operator.find_by_market' },
        {
          market_id: '12',
          // Audit 2026-11-22 #10: o'chirilganlar ham (qoldig'ini yopish uchun).
          query: { page: 1, limit: 100, include_deleted: true },
          requester: { id: '12', roles: ['market'] },
        },
      );
      expect(financeCalls('finance.operator.market_payment.record')).toEqual([
        [
          { cmd: 'finance.operator.market_payment.record' },
          {
            market_id: '12',
            operator_id: '41',
            amount: 150000,
            paid_at: '2026-11-17',
            note: 'Oktabr',
            recorded_by_id: '12',
            recorded_by_role: 'market',
            idempotency_key: 'op-key-1',
            operator_deleted: false,
          },
        ],
      ]);
      // Eski kassa yo'li hech qachon chaqirilmaydi.
      expect(financeCalls('finance.operator.payment.create')).toHaveLength(0);
      expect(res.body.data).toMatchObject({
        id: '301',
        operator_name: 'Madina Xoliqova',
      });
    });

    it('takroriy so`rov (finance 200) — HTTP 200', async () => {
      finance.send.mockReturnValueOnce(
        of({ statusCode: 200, data: { id: '301', idempotent: true } }),
      );
      await request(http())
        .post('/finance/operator-payments')
        .set(as(['market']))
        .set('Idempotency-Key', 'op-key-1')
        .send(BODY)
        .expect(200);
    });

    it('begona operator — 404, finance chaqirilmaydi', async () => {
      await request(http())
        .post('/finance/operator-payments')
        .set(as(['market']))
        .set('Idempotency-Key', 'k')
        .send({ ...BODY, operator_id: '77' })
        .expect(404);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it.each([
      ['market_id tanada', { ...BODY, market_id: '99' }],
      ['summa 0', { ...BODY, amount: 0 }],
      ['3 kasr', { ...BODY, amount: 10.005 }],
      ['sana shakli', { ...BODY, paid_at: '17.11.2026' }],
      ['izoh 500 dan uzun', { ...BODY, note: 'x'.repeat(501) }],
    ])('%s — 400, finance chaqirilmaydi', async (_name, body) => {
      await request(http())
        .post('/finance/operator-payments')
        .set(as(['market']))
        .set('Idempotency-Key', 'k')
        .send(body)
        .expect(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('Idempotency-Key siz — 400', async () => {
      await request(http())
        .post('/finance/operator-payments')
        .set(as(['market']))
        .send(BODY)
        .expect(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it.each([['superadmin'], ['admin'], ['market_operator'], ['manager']])(
      '%s — 403 (endi faqat market yozadi)',
      async (role) => {
        await request(http())
          .post('/finance/operator-payments')
          .set(as([role], '1'))
          .set('Idempotency-Key', 'k')
          .send(BODY)
          .expect(403);
        expect(finance.send).not.toHaveBeenCalled();
        expect(identity.send).not.toHaveBeenCalled();
      },
    );
  });

  it('GET balances — barcha sahifalar operatorlari finance`ga, ism va holat qo`shiladi', async () => {
    identity.send
      .mockReturnValueOnce(
        of({
          data: {
            items: [{ id: '41', name: 'Madina', status: 'active' }],
            meta: { page: 1, totalPages: 2 },
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            items: [{ id: '43', name: 'Kamola', status: 'inactive' }],
            meta: { page: 2, totalPages: 2 },
          },
        }),
      );
    finance.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        data: {
          items: [
            { operator_id: '41', earned: 100, paid: 40, balance: 60 },
            { operator_id: '43', earned: 0, paid: 10, balance: -10 },
          ],
          totals: { earned: 100, paid: 50, balance: 50 },
        },
      }),
    );

    const res = await request(http())
      .get('/finance/operator-payments/balances')
      .set(as(['market']))
      .expect(200);

    expect(identity.send).toHaveBeenCalledTimes(2);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_balances' },
      { operator_ids: ['41', '43'] },
    );
    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        operator_id: '41',
        operator_name: 'Madina',
        status: 'active',
        balance: 60,
      }),
      expect.objectContaining({
        operator_id: '43',
        operator_name: 'Kamola',
        status: 'inactive',
        balance: -10,
      }),
    ]);
    expect(res.body.data.totals).toEqual({
      earned: 100,
      paid: 50,
      balance: 50,
    });
  });

  it('GET tarix — market_id JWT dan, begona operator filtri 404', async () => {
    finance.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        data: {
          items: [{ id: '5', operator_id: '41', amount: 100 }],
          pagination: { total: 1, page: 2, limit: 10, totalPages: 1 },
        },
      }),
    );
    const res = await request(http())
      .get('/finance/operator-payments?operator_id=41&page=2&limit=10')
      .set(as(['market']))
      .expect(200);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_payment.list' },
      {
        market_id: '12',
        operator_ids: ['41', '43'],
        operator_id: '41',
        page: 2,
        limit: 10,
      },
    );
    expect(res.body.data.items[0]).toMatchObject({
      operator_name: 'Madina Xoliqova',
    });

    jest.clearAllMocks();
    await request(http())
      .get('/finance/operator-payments?operator_id=77')
      .set(as(['market']))
      .expect(404);
    expect(finance.send).not.toHaveBeenCalled();

    await request(http())
      .get('/finance/operator-payments?market_id=99')
      .set(as(['market']))
      .expect(400);
    await request(http())
      .get('/finance/operator-payments/balances')
      .set(as(['superadmin'], '1'))
      .expect(403);
  });

  it('POST :id/cancel — sabab majburiy; finance`ga JWT market_id bilan', async () => {
    await request(http())
      .post('/finance/operator-payments/301/cancel')
      .set(as(['market']))
      .send({ reason: '   ' })
      .expect(400);
    await request(http())
      .post('/finance/operator-payments/301/cancel')
      .set(as(['market']))
      .send({})
      .expect(400);
    expect(finance.send).not.toHaveBeenCalled();

    finance.send.mockReturnValueOnce(
      of({ statusCode: 200, data: { id: '301', status: 'cancelled' } }),
    );
    await request(http())
      .post('/finance/operator-payments/301/cancel')
      .set(as(['market']))
      .send({ reason: 'Summa xato' })
      .expect(200);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_payment.cancel' },
      {
        market_id: '12',
        payment_id: '301',
        reason: 'Summa xato',
        cancelled_by_id: '12',
        cancelled_by_role: 'market',
      },
    );

    await request(http())
      .post('/finance/operator-payments/301/cancel')
      .set(as(['admin'], '1'))
      .send({ reason: 'Summa xato' })
      .expect(403);
  });
});

describe('F2qp6FtE — FinanceGatewayController endi operatorga to`lamaydi', () => {
  it('eski superadmin yo`li (`POST /finance/operator-payments`) finance controller`da yo`q', async () => {
    const finance = { send: jest.fn(() => of({ statusCode: 201, data: {} })) };
    const moduleRef = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = {
            sub: '1',
            roles: ['superadmin'],
          };
          return true;
        },
      })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .post('/finance/operator-payments')
        .send({ operator_id: '42', amount: 1000 })
        .expect(404);
      expect(finance.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
