import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Observable, of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  BRANCH_SHIFT_MANAGER_ONLY_MESSAGE,
  FinanceGatewayController,
} from './finance-gateway.controller';

/**
 * 32Sw3DfC — GET /finance/shift/current kassa doirasi:
 *  - superadmin/admin `?cashbox_user_id=<filial>` bilan filial smenasini va
 *    `required` ni O'QIYDI (filial mavjud bo'lishi shart — aks holda 404);
 *  - ular filial smenasini OCHMAYDI → `can_open: false`, smena yo'q bo'lsa
 *    `lock_message` «Filial menejeri smenani ochishi kerak»;
 *  - menejer — o'z filiali (boshqasi 403) yoki `0` (N20: HQ asosiy kassa
 *    smenasi holati, pul maydonlarisiz);
 *  - registrator — faqat MAIN.
 * RolesGuard — haqiqiysi (rol `x-test-role` sarlavhasidan).
 */
describe('32Sw3DfC — GET /finance/shift/current: superadmin filial smenasi, qulf matni, menejer doirasi', () => {
  let app: INestApplication;
  type Reply = Observable<unknown>;
  const finance = { send: jest.fn((): Reply => of({})) };
  const branch = { send: jest.fn((): Reply => of({ data: { id: '13' } })) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  const shiftReply = (
    cashboxUserId: string,
    shift: Record<string, unknown> | null,
    required = true,
  ) =>
    of({
      statusCode: 200,
      message: shift ? 'Current shift' : "Ochiq smena yo'q",
      data: {
        shift,
        required,
        cashbox_user_id: cashboxUserId,
        last_closed: {
          id: '30',
          status: 'closed',
          closing_balance_cash: 120000,
          discrepancy_cash: 20000,
        },
      },
    });
  const openShift = (cashboxUserId: string) => ({
    id: '41',
    status: 'open',
    cashbox_user_id: cashboxUserId,
    opened_by: '25',
    opened_by_name: 'Menejer Urgut',
    opened_at: '2026-10-25T03:00:00.000Z',
    opening_balance_cash: 80348000,
    opening_balance_card: 15000,
  });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: finance },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branch },
        { provide: 'ORDER', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const role = req.headers['x-test-role'] ?? 'superadmin';
          req.user = {
            sub: role === 'manager' ? '25' : '9',
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
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    finance.send.mockReset();
    branch.send.mockReset();
    branch.send.mockImplementation(() => of({ data: { id: '13' } }));
  });

  const financeCalls = () =>
    finance.send.mock.calls as unknown as Array<[unknown, unknown]>;
  const branchCalls = () =>
    branch.send.mock.calls as unknown as Array<[unknown, unknown]>;

  describe('superadmin / admin', () => {
    it.each(['superadmin', 'admin'])(
      '%s: ?cashbox_user_id=13 — filial tekshiriladi, shu filial smenasi o`qiladi; smena yo`q → can_open:false + qulf matni',
      async (role) => {
        finance.send.mockImplementation(() => shiftReply('13', null));

        const result = await request(http())
          .get('/finance/shift/current?cashbox_user_id=13')
          .set('x-test-role', role);

        expect(result.status).toBe(200);
        expect(branchCalls()[0]).toEqual([
          { cmd: 'branch.find_by_id' },
          {
            id: '13',
            requester: { id: '9', roles: [role], branch_id: null },
          },
        ]);
        expect(financeCalls()).toEqual([
          [{ cmd: 'finance.shift.current' }, { cashbox_user_id: '13' }],
        ]);
        expect(result.body.data).toMatchObject({
          shift: null,
          required: true,
          cashbox_user_id: '13',
          can_open: false,
          lock_message: 'Filial menejeri smenani ochishi kerak',
        });
        expect(BRANCH_SHIFT_MANAGER_ONLY_MESSAGE).toBe(
          'Filial menejeri smenani ochishi kerak',
        );
      },
    );

    it('filial smenasi ochiq — smena qaytadi, qulf matni null (can_open baribir false)', async () => {
      finance.send.mockImplementation(() => shiftReply('13', openShift('13')));

      const result = await request(http()).get(
        '/finance/shift/current?cashbox_user_id=13',
      );

      expect(result.body.data).toMatchObject({
        shift: { id: '41', status: 'open', cashbox_user_id: '13' },
        can_open: false,
        lock_message: null,
      });
    });

    it('mavjud bo`lmagan filial → 404, finance chaqirilmaydi', async () => {
      branch.send.mockImplementation(() =>
        throwError(() => ({ statusCode: 404, message: 'Branch not found' })),
      );

      const result = await request(http()).get(
        '/finance/shift/current?cashbox_user_id=999',
      );

      expect(result.status).toBe(404);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('?cashbox_user_id=0 va parametrsiz — MAIN (avvalgidek `{}`), can_open:true, qulf yo`q, filial tekshirilmaydi', async () => {
      finance.send.mockImplementation(() => shiftReply('0', null));

      for (const url of [
        '/finance/shift/current?cashbox_user_id=0',
        '/finance/shift/current',
      ]) {
        const result = await request(http()).get(url);
        expect(result.status).toBe(200);
        expect(result.body.data).toMatchObject({
          cashbox_user_id: '0',
          can_open: true,
          lock_message: null,
        });
      }
      expect(financeCalls()).toEqual([
        [{ cmd: 'finance.shift.current' }, {}],
        [{ cmd: 'finance.shift.current' }, {}],
      ]);
      expect(branch.send).not.toHaveBeenCalled();
    });

    it('raqam bo`lmagan cashbox_user_id → 400', async () => {
      const result = await request(http()).get(
        '/finance/shift/current?cashbox_user_id=abc',
      );

      expect(result.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('superadmin filial smenasini OCHA OLMAYDI: POST shift/open doirasi har doim MAIN (cashbox_user_id whitelist → 400)', async () => {
      finance.send.mockImplementation(() => of({ statusCode: 201, data: {} }));

      const rejected = await request(http())
        .post('/finance/shift/open')
        .send({ cashbox_user_id: '13' });
      const opened = await request(http()).post('/finance/shift/open').send({});

      expect(rejected.status).toBe(400);
      expect(opened.status).toBe(201);
      expect(financeCalls()).toEqual([
        [{ cmd: 'finance.shift.open' }, { opened_by: '9' }],
      ]);
    });
  });

  describe('menejer', () => {
    it('parametrsiz yoki o`z filiali — o`z filiali kassasi, can_open:true (smena yo`q bo`lsa ham qulf matni yo`q)', async () => {
      finance.send.mockImplementation(() => shiftReply('13', null));

      for (const url of [
        '/finance/shift/current',
        '/finance/shift/current?cashbox_user_id=13',
      ]) {
        const result = await request(http())
          .get(url)
          .set('x-test-role', 'manager');
        expect(result.status).toBe(200);
        expect(result.body.data).toMatchObject({
          cashbox_user_id: '13',
          can_open: true,
          lock_message: null,
        });
      }
      expect(financeCalls()).toEqual([
        [{ cmd: 'finance.shift.current' }, { cashbox_user_id: '13' }],
        [{ cmd: 'finance.shift.current' }, { cashbox_user_id: '13' }],
      ]);
    });

    it('boshqa filial → 403, finance chaqirilmaydi', async () => {
      const result = await request(http())
        .get('/finance/shift/current?cashbox_user_id=14')
        .set('x-test-role', 'manager');

      expect(result.status).toBe(403);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('N20: ?cashbox_user_id=0 — HQ asosiy kassa smenasi HOLATI, pul maydonlari va last_closed chiqmaydi', async () => {
      finance.send.mockImplementation(() => shiftReply('0', openShift('0')));

      const result = await request(http())
        .get('/finance/shift/current?cashbox_user_id=0')
        .set('x-test-role', 'manager');

      expect(result.status).toBe(200);
      expect(financeCalls()).toEqual([[{ cmd: 'finance.shift.current' }, {}]]);
      expect(result.body.data).toEqual({
        shift: {
          id: '41',
          status: 'open',
          cashbox_user_id: '0',
          opened_at: '2026-10-25T03:00:00.000Z',
          opened_by_name: 'Menejer Urgut',
        },
        required: true,
        cashbox_user_id: '0',
        status_only: true,
        can_open: false,
        lock_message: null,
      });
    });

    it('N20: MAIN smenasi yo`q — shift null, status_only', async () => {
      finance.send.mockImplementation(() => shiftReply('0', null, false));

      const result = await request(http())
        .get('/finance/shift/current?cashbox_user_id=0')
        .set('x-test-role', 'manager');

      expect(result.body.data).toMatchObject({
        shift: null,
        required: false,
        status_only: true,
      });
      expect(result.body.data).not.toHaveProperty('last_closed');
    });
  });

  describe('registrator', () => {
    it('faqat MAIN: parametrsiz yoki 0 — `{}`; filial — 403', async () => {
      finance.send.mockImplementation(() => shiftReply('0', null));

      const main = await request(http())
        .get('/finance/shift/current?cashbox_user_id=0')
        .set('x-test-role', 'registrator');
      const branchView = await request(http())
        .get('/finance/shift/current?cashbox_user_id=13')
        .set('x-test-role', 'registrator');

      expect(main.status).toBe(200);
      expect(main.body.data).toMatchObject({ can_open: true });
      expect(branchView.status).toBe(403);
      expect(financeCalls()).toEqual([[{ cmd: 'finance.shift.current' }, {}]]);
    });
  });

  it('market/kuryer roli → 403 (RolesGuard)', async () => {
    for (const role of ['market', 'courier', 'market_operator']) {
      const result = await request(http())
        .get('/finance/shift/current')
        .set('x-test-role', role);
      expect(result.status).toBe(403);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });
});
