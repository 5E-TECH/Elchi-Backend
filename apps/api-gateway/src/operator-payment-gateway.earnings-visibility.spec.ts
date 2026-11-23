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
import { OperatorPaymentGatewayController } from './operator-payment-gateway.controller';

/**
 * 2026-11-20 — «operator nomidan yaratilgan buyurtmalarga xizmat haqqi
 * ko'rsatilmayapti»: market «Operatorlar → To'lovlar» hisobida
 *  - har operator buyurtmalari soni (jami / sotilgan / yo'lda) — komissiya
 *    faqat sotuvda yozilgani endi ko'rinadi;
 *  - o'chirilgan operator (daromadi / to'lovi bo'lsa) hisobdan yo'qolmaydi;
 *  - `GET earnings` — «Ishlab topdi» tarkibi (qaysi buyurtmadan qancha).
 */
describe('operator hisobi — buyurtmalar soni, o`chirilganlar, daromad qatorlari', () => {
  let app: INestApplication;
  type Call = [{ cmd: string }, Record<string, unknown>];
  const OPERATORS = [
    { id: '41', name: 'Madina', status: 'active', is_deleted: false },
    { id: '43', name: 'Kamola', status: 'inactive', is_deleted: false },
    { id: '47', name: 'Sevinch', status: 'inactive', is_deleted: true },
    { id: '48', name: 'Bo`sh', status: 'inactive', is_deleted: true },
  ];
  const identity = {
    send: jest.fn<unknown, Call>(() =>
      of({
        statusCode: 200,
        data: {
          items: OPERATORS,
          meta: { page: 1, limit: 100, total: 4, totalPages: 1 },
        },
      }),
    ),
  };
  const finance = { send: jest.fn<unknown, Call>() };
  const order = { send: jest.fn<unknown, Call>() };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const asMarket = {
    'x-test-user': JSON.stringify({ sub: '12', roles: ['market'] }),
  };

  const balances = (items: Array<Record<string, unknown>>) =>
    of({
      statusCode: 200,
      data: { items, totals: { earned: 160, paid: 50, balance: 110 } },
    });
  const BALANCE_ITEMS = [
    { operator_id: '41', earned: 100, paid: 40, balance: 60 },
    { operator_id: '43', earned: 0, paid: 0, balance: 0 },
    { operator_id: '47', earned: 60, paid: 10, balance: 50 },
    { operator_id: '48', earned: 0, paid: 0, balance: 0 },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OperatorPaymentGatewayController],
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
  beforeEach(() => jest.clearAllMocks());

  it('GET balances — o`chirilganlar ham so`raladi; buyurtmalar soni qo`shiladi; bo`sh o`chirilgan qator chiqmaydi', async () => {
    finance.send.mockReturnValueOnce(balances(BALANCE_ITEMS));
    order.send.mockReturnValueOnce(
      of({
        items: [
          {
            operator_id: '41',
            total_orders: 57,
            sold_orders: 41,
            pending_orders: 9,
          },
          {
            operator_id: '47',
            total_orders: 3,
            sold_orders: 3,
            pending_orders: 0,
          },
        ],
      }),
    );

    const res = await request(http())
      .get('/finance/operator-payments/balances')
      .set(asMarket)
      .expect(200);

    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.market_operator.find_by_market' },
      {
        market_id: '12',
        query: { page: 1, limit: 100, include_deleted: true },
        requester: { id: '12', roles: ['market'] },
      },
    );
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_balances' },
      { operator_ids: ['41', '43', '47', '48'] },
    );
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.operator.order_counts' },
      { market_id: '12', operator_ids: ['41', '43', '47', '48'] },
    );
    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        operator_id: '41',
        status: 'active',
        orders_total: 57,
        orders_sold: 41,
        orders_pending: 9,
      }),
      // Buyurtmasiz — 0 (noma'lum emas).
      expect.objectContaining({
        operator_id: '43',
        status: 'inactive',
        orders_total: 0,
        orders_sold: 0,
        orders_pending: 0,
      }),
      // O'chirilgan, lekin daromadi bor — hisobda qoladi.
      expect.objectContaining({
        operator_id: '47',
        operator_name: 'Sevinch',
        status: 'deleted',
        balance: 50,
      }),
    ]);
    expect(res.body.data.totals).toEqual({
      earned: 160,
      paid: 50,
      balance: 110,
    });
  });

  it('GET balances — order-service javob bermasa hisob baribir qaytadi, soni null', async () => {
    finance.send.mockReturnValueOnce(balances(BALANCE_ITEMS.slice(0, 1)));
    order.send.mockReturnValueOnce(throwError(() => new Error('down')));

    const res = await request(http())
      .get('/finance/operator-payments/balances')
      .set(asMarket)
      .expect(200);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({
        operator_id: '41',
        balance: 60,
        orders_total: null,
        orders_sold: null,
        orders_pending: null,
      }),
    ]);
  });

  it('GET earnings — o`z operatori (o`chirilgani ham): sahifa → offset, faqat ko`rsatish maydonlari', async () => {
    finance.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        message: 'operator earnings',
        data: {
          rows: [
            {
              id: '901',
              operator_id: '47',
              market_id: '12',
              order_id: '55120',
              amount: '12500.00',
              order_total_price: '250000.00',
              commission_type: 'percent',
              commission_value: '5.00',
              isDeleted: false,
              createdAt: '2026-11-18T09:12:00.000Z',
            },
          ],
          total: 21,
          limit: 10,
          offset: 10,
        },
      }),
    );

    const res = await request(http())
      .get('/finance/operator-payments/earnings?operator_id=47&page=2&limit=10')
      .set(asMarket)
      .expect(200);

    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.earning.list' },
      { operator_id: '47', limit: 10, offset: 10 },
    );
    expect(res.body.data).toEqual({
      items: [
        {
          id: '901',
          order_id: '55120',
          amount: 12500,
          order_total_price: 250000,
          commission_type: 'percent',
          commission_value: 5,
          created_at: '2026-11-18T09:12:00.000Z',
        },
      ],
      pagination: { total: 21, page: 2, limit: 10, totalPages: 3 },
    });
  });

  it('GET earnings — begona operator 404, operator_id majburiy, market bo`lmasa 403', async () => {
    await request(http())
      .get('/finance/operator-payments/earnings?operator_id=77')
      .set(asMarket)
      .expect(404);
    await request(http())
      .get('/finance/operator-payments/earnings')
      .set(asMarket)
      .expect(400);
    await request(http())
      .get('/finance/operator-payments/earnings?operator_id=41')
      .set({
        'x-test-user': JSON.stringify({ sub: '1', roles: ['superadmin'] }),
      })
      .expect(403);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('POST (to`lov yozish) — o`chirilmagan operator: `operator_deleted: false`', async () => {
    finance.send.mockReturnValueOnce(
      of({ statusCode: 201, data: { id: '301', operator_id: '41' } }),
    );
    await request(http())
      .post('/finance/operator-payments')
      .set(asMarket)
      .set('Idempotency-Key', 'k-1')
      .send({ operator_id: '41', amount: 1000, paid_at: '2026-11-17' })
      .expect(201);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.market_operator.find_by_market' },
      expect.objectContaining({
        query: { page: 1, limit: 100, include_deleted: true },
      }),
    );
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_payment.record' },
      expect.objectContaining({ operator_id: '41', operator_deleted: false }),
    );
  });

  it('POST (audit 2026-11-22 #10) — o`chirilgan o`z operatori: 404 emas, finance qoldiq doirasida yozadi (`operator_deleted: true`)', async () => {
    finance.send.mockReturnValueOnce(
      of({ statusCode: 201, data: { id: '302', operator_id: '47' } }),
    );
    const res = await request(http())
      .post('/finance/operator-payments')
      .set(asMarket)
      .set('Idempotency-Key', 'k-2')
      .send({ operator_id: '47', amount: 50, paid_at: '2026-11-17' })
      .expect(201);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.market_payment.record' },
      expect.objectContaining({
        market_id: '12',
        operator_id: '47',
        amount: 50,
        operator_deleted: true,
      }),
    );
    expect(res.body.data).toMatchObject({ operator_name: 'Sevinch' });
  });

  it('POST — begona (ro`yxatda yo`q) operator baribir 404, finance chaqirilmaydi', async () => {
    await request(http())
      .post('/finance/operator-payments')
      .set(asMarket)
      .set('Idempotency-Key', 'k-3')
      .send({ operator_id: '99', amount: 60, paid_at: '2026-11-17' })
      .expect(404);
    expect(finance.send).not.toHaveBeenCalled();
  });
});
