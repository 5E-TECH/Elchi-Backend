import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PickupVisitGatewayController } from './pickup-visit-gateway.controller';
import { UpdateCashboxBalanceRequestDto } from './dto/finance.swagger.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * B824gOu5 — `/finance/pickup-visits`: HAQIQIY RolesGuard + main.ts dagi
 * ValidationPipe. Summa va chegara logistics sozlamasidan, klientdan emas.
 */
describe('B824gOu5 — /finance/pickup-visits gateway', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn<unknown, [{ cmd: string }, Record<string, unknown>]>(() =>
      of({ statusCode: 201, data: { id: '301' } }),
    ),
  };
  const logistics = {
    send: jest.fn(() =>
      of({
        statusCode: 200,
        data: { pickup_fee: 20000, pickup_free_from_count: 10 },
      }),
    ),
  };
  const identity = {
    send: jest.fn(() => of({ data: { id: '55', role: 'courier' } })),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (roles: string[], sub = '7') => ({
    'x-test-user': JSON.stringify({ sub, roles }),
  });
  const BODY = { market_id: '12', courier_id: '55', parcel_count: 9 };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PickupVisitGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'LOGISTICS', useValue: logistics },
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

  it('sozlama serverdan olinib finance`ga uzatiladi', async () => {
    await request(http())
      .post('/finance/pickup-visits')
      .set(as(['registrator']))
      .set('Idempotency-Key', 'k-1')
      .send(BODY)
      .expect(201);

    expect(logistics.send).toHaveBeenCalledWith(
      { cmd: 'logistics.delivery.settings.get' },
      {},
    );
    const [pattern, payload] = finance.send.mock.calls[0];
    expect(pattern).toEqual({ cmd: 'finance.pickup_visit.record' });
    expect(payload).toMatchObject({
      market_id: '12',
      courier_id: '55',
      parcel_count: 9,
      idempotency_key: 'k-1',
      created_by: '7',
      settings: { pickup_fee: 20000, pickup_free_from_count: 10 },
    });
  });

  it.each([[{ fee: 0 }], [{ pickup_fee: 1 }], [{ is_free: true }]])(
    'klient haqni bera olmaydi: %j — 400',
    async (extra) => {
      await request(http())
        .post('/finance/pickup-visits')
        .set(as(['admin']))
        .set('Idempotency-Key', 'k-2')
        .send({ ...BODY, ...extra })
        .expect(400);
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it('Idempotency-Key majburiy', async () => {
    await request(http())
      .post('/finance/pickup-visits')
      .set(as(['admin']))
      .send(BODY)
      .expect(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ parcel_count: 0 }],
    [{ parcel_count: 1.5 }],
    [{ market_id: 'x' }],
  ])('yaroqsiz tana %j — 400', async (patch) => {
    await request(http())
      .post('/finance/pickup-visits')
      .set(as(['admin']))
      .set('Idempotency-Key', 'k-3')
      .send({ ...BODY, ...patch })
      .expect(400);
  });

  it.each([['courier'], ['market'], ['manager'], ['operator'], ['investor']])(
    '%s qayd qila olmaydi',
    async (role) => {
      await request(http())
        .post('/finance/pickup-visits')
        .set(as([role]))
        .set('Idempotency-Key', 'k-4')
        .send(BODY)
        .expect(403);
    },
  );

  it('courier_id kuryer emas — 400, pul yo`li chaqirilmaydi', async () => {
    identity.send.mockReturnValueOnce(
      of({ data: { id: '55', role: 'market' } }),
    );
    await request(http())
      .post('/finance/pickup-visits')
      .set(as(['admin']))
      .set('Idempotency-Key', 'k-5')
      .send(BODY)
      .expect(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('logistics javob bermasa — 504, yozuv yo`q', async () => {
    logistics.send.mockReturnValueOnce(throwError(() => new TimeoutError()));
    await request(http())
      .post('/finance/pickup-visits')
      .set(as(['admin']))
      .set('Idempotency-Key', 'k-6')
      .send(BODY)
      .expect(504);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('MARKET — faqat o`zi', async () => {
    await request(http())
      .get('/finance/pickup-visits')
      .set(as(['market'], '12'))
      .expect(200);
    expect(finance.send.mock.calls[0][1]).toMatchObject({ market_id: '12' });

    await request(http())
      .get('/finance/pickup-visits?market_id=13')
      .set(as(['market'], '12'))
      .expect(403);
  });

  it('xodim filtrlar bilan ko`radi', async () => {
    await request(http())
      .get(
        '/finance/pickup-visits?market_id=13&is_free=true&from_date=2026-10-01&limit=5',
      )
      .set(as(['registrator']))
      .expect(200);
    expect(finance.send.mock.calls[0][1]).toMatchObject({
      market_id: '13',
      is_free: 'true',
      from_date: '2026-10-01',
      limit: 5,
    });
  });

  it('`pickup_fee` qo`lda PATCH /finance/cashbox/balance ga o`tmaydi', () => {
    const dto = plainToInstance(UpdateCashboxBalanceRequestDto, {
      amount: 1,
      operation_type: 'expense',
      source_type: 'pickup_fee',
    });
    expect(validateSync(dto).map((error) => error.property)).toContain(
      'source_type',
    );
  });
});
