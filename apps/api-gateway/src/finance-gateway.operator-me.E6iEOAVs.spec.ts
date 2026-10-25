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
import { ROLES_KEY } from './auth/roles.decorator';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * E6iEOAVs — market operatori o'z daromadi: GET finance/operators/me/
 * {balance,earnings,payments}. operator_id FAQAT JWT'dan; 'me' marshrutlari
 * `operators/:operator_id/*` dan OLDIN; admin variantlari market operatoriga
 * yopiq. RolesGuard — HAQIQIYSI (rol `x-test-role` sarlavhasidan).
 */
describe('E6iEOAVs — GET /finance/operators/me/* (market operatori o`z daromadi)', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn((pattern: { cmd: string }) =>
      of({ statusCode: 200, data: { cmd: pattern.cmd } }),
    ),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
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
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const role = req.headers['x-test-role'] ?? 'market_operator';
          req.user = {
            sub: role === 'market_operator' ? '77' : '9',
            username: 'u',
            roles: [role],
            ...(role === 'manager' ? { branch_id: '13' } : {}),
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => finance.send.mockClear());

  const calls = () =>
    finance.send.mock.calls as unknown as Array<
      [{ cmd: string }, Record<string, unknown>]
    >;

  it('rollar: uchala `me` marshruti — faqat market_operator', () => {
    for (const method of [
      'findMyOperatorBalance',
      'listMyOperatorEarnings',
      'listMyOperatorPayments',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(
        FinanceGatewayController.prototype,
        method,
      );
      expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
        'market_operator',
      ]);
    }
  });

  it('GET me/balance → finance.operator.balance.find, operator_id = JWT sub', async () => {
    const result = await request(http()).get('/finance/operators/me/balance');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      statusCode: 200,
      data: { cmd: 'finance.operator.balance.find' },
    });
    expect(calls()).toEqual([
      [{ cmd: 'finance.operator.balance.find' }, { operator_id: '77' }],
    ]);
  });

  it('GET me/earnings — limit/offset admin varianti bilan bir xil uzatiladi', async () => {
    const result = await request(http()).get(
      '/finance/operators/me/earnings?limit=10&offset=20',
    );

    expect(result.status).toBe(200);
    expect(calls()).toEqual([
      [
        { cmd: 'finance.operator.earning.list' },
        { operator_id: '77', limit: 10, offset: 20 },
      ],
    ]);
  });

  it('GET me/payments — parametrsiz: sukut (limit/offset undefined)', async () => {
    const result = await request(http()).get('/finance/operators/me/payments');

    expect(result.status).toBe(200);
    expect(calls()).toEqual([
      [
        { cmd: 'finance.operator.payment.list' },
        { operator_id: '77', limit: undefined, offset: undefined },
      ],
    ]);
  });

  it('raqam bo`lmagan limit/offset — sukutga tushadi (NaN uzatilmaydi)', async () => {
    await request(http()).get(
      '/finance/operators/me/earnings?limit=abc&offset=',
    );

    expect(calls()[0][1]).toEqual({
      operator_id: '77',
      limit: undefined,
      offset: undefined,
    });
  });

  it('boshqa operator id sini query bilan so`rab bo`lmaydi — har doim JWT sub', async () => {
    await request(http()).get(
      '/finance/operators/me/earnings?operator_id=42&limit=5',
    );
    await request(http()).get('/finance/operators/me/balance?operator_id=42');

    expect(calls().map(([, payload]) => payload.operator_id)).toEqual([
      '77',
      '77',
    ]);
  });

  it('market operatori admin variantlariga (operators/:id/*) kira olmaydi → 403', async () => {
    for (const path of ['balance', 'earnings', 'payments']) {
      const own = await request(http()).get(`/finance/operators/77/${path}`);
      const other = await request(http()).get(`/finance/operators/42/${path}`);
      expect(own.status).toBe(403);
      expect(other.status).toBe(403);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('superadmin/admin/menejer `me` marshrutiga → 403 ("me" operator_id sifatida admin marshrutiga tushmaydi)', async () => {
    for (const role of ['superadmin', 'admin', 'manager', 'market']) {
      for (const path of ['balance', 'earnings', 'payments']) {
        const result = await request(http())
          .get(`/finance/operators/me/${path}`)
          .set('x-test-role', role);
        expect(result.status).toBe(403);
      }
    }
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('REGRESSIYA: admin varianti o`zgarmagan — superadmin operators/42/balance', async () => {
    const result = await request(http())
      .get('/finance/operators/42/balance')
      .set('x-test-role', 'superadmin');

    expect(result.status).toBe(200);
    expect(calls()).toEqual([
      [{ cmd: 'finance.operator.balance.find' }, { operator_id: '42' }],
    ]);
  });
});
