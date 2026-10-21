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
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari gateway kontrakti:
 * marshrutlar → RMQ cmd, whitelist / validatsiya, JWT'dan `created_by` /
 * `updated_by` / `deleted_by`, rollar (HAQIQIY RolesGuard: ro'yxat —
 * superadmin/admin/menejer, CUD — faqat superadmin), `include_deleted`
 * faqat superadminga, `PATCH /cashbox/spend` da ixtiyoriy
 * `expense_category_id` (kirimda — 400).
 */
describe('Elchi Pochta №1 — /finance/cashbox/expense-categories gateway kontrakti', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() => of({ statusCode: 200, data: { ok: true } })),
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
      // Rol `x-test-role` sarlavhasidan; RolesGuard — haqiqiysi.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          const role = req.headers['x-test-role'] ?? 'superadmin';
          req.user = {
            sub: '9',
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

  beforeEach(() => {
    finance.send.mockClear();
  });

  const lastCall = () =>
    (finance.send.mock.calls as unknown as Array<[{ cmd: string }, any]>).at(
      -1,
    );

  it('GET — superadmin/admin/menejer ko`radi; include_deleted faqat superadminga o`tadi', async () => {
    for (const [role, expected] of [
      ['superadmin', true],
      ['admin', false],
      ['manager', false],
    ] as const) {
      finance.send.mockClear();
      const res = await request(http())
        .get('/finance/cashbox/expense-categories?include_deleted=true')
        .set('x-test-role', role);
      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'finance.cashbox.expense_categories.list' },
        { include_deleted: expected },
      ]);
    }

    finance.send.mockClear();
    await request(http())
      .get('/finance/cashbox/expense-categories')
      .set('x-test-role', 'superadmin');
    expect(lastCall()?.[1]).toEqual({ include_deleted: false });

    for (const role of ['courier', 'market', 'registrator']) {
      const res = await request(http())
        .get('/finance/cashbox/expense-categories')
        .set('x-test-role', role);
      expect(res.status).toBe(403);
    }
  });

  it('POST — created_by JWT dan; nom bo`sh / 100+ belgi, sort_order manfiy, begona maydon → 400', async () => {
    const ok = await request(http())
      .post('/finance/cashbox/expense-categories')
      .send({ name: 'Kuryer jarimalari', description: 'Jarima', sort_order: 18 });
    expect(ok.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.expense_categories.create' },
      {
        name: 'Kuryer jarimalari',
        description: 'Jarima',
        sort_order: 18,
        created_by: '9',
      },
    ]);

    finance.send.mockClear();
    for (const body of [
      {},
      { name: '' },
      { name: 'x'.repeat(101) },
      { name: 'Ok', description: 'x'.repeat(501) },
      { name: 'Ok', sort_order: -1 },
      { name: 'Ok', sort_order: 1.5 },
      { name: 'Ok', is_deleted: true },
    ]) {
      const bad = await request(http())
        .post('/finance/cashbox/expense-categories')
        .send(body);
      expect(bad.status).toBe(400);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('PATCH /:id — updated_by JWT dan, description: null (tozalash) o`tadi; noto`g`ri id → 400', async () => {
    const ok = await request(http())
      .patch('/finance/cashbox/expense-categories/4')
      .send({ name: 'Ijara', description: null });
    expect(ok.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.expense_categories.update' },
      { id: '4', name: 'Ijara', description: null, updated_by: '9' },
    ]);

    await request(http())
      .patch('/finance/cashbox/expense-categories/4')
      .send({ sort_order: '3' });
    expect(lastCall()?.[1]).toEqual({
      id: '4',
      sort_order: 3,
      updated_by: '9',
    });

    finance.send.mockClear();
    const badId = await request(http())
      .patch('/finance/cashbox/expense-categories/abc')
      .send({ name: 'x' });
    expect(badId.status).toBe(400);
    const badBody = await request(http())
      .patch('/finance/cashbox/expense-categories/4')
      .send({ name: '' });
    expect(badBody.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('DELETE /:id — soft o`chirish cmd, deleted_by JWT dan; noto`g`ri id → 400', async () => {
    const ok = await request(http()).delete(
      '/finance/cashbox/expense-categories/7',
    );
    expect(ok.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.expense_categories.delete' },
      { id: '7', deleted_by: '9' },
    ]);

    finance.send.mockClear();
    const bad = await request(http()).delete(
      '/finance/cashbox/expense-categories/7x',
    );
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('⭐ qo`shish / tahrirlash / o`chirish — faqat superadmin: admin va menejer 403, finance ga hech narsa ketmaydi', async () => {
    for (const role of ['admin', 'manager']) {
      const created = await request(http())
        .post('/finance/cashbox/expense-categories')
        .set('x-test-role', role)
        .send({ name: 'Boshqa' });
      const updated = await request(http())
        .patch('/finance/cashbox/expense-categories/1')
        .set('x-test-role', role)
        .send({ name: 'Boshqa' });
      const deleted = await request(http())
        .delete('/finance/cashbox/expense-categories/1')
        .set('x-test-role', role);
      expect([created.status, updated.status, deleted.status]).toEqual([
        403, 403, 403,
      ]);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('rollar metadata: ro`yxat — superadmin/admin/menejer, CUD — faqat superadmin', () => {
    const rolesOf = (method: string) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(
          FinanceGatewayController.prototype,
          method,
        )?.value,
      );
    expect(rolesOf('listCashboxExpenseCategories')).toEqual([
      'superadmin',
      'admin',
      'manager',
    ]);
    for (const method of [
      'createCashboxExpenseCategory',
      'updateCashboxExpenseCategory',
      'deleteCashboxExpenseCategory',
    ]) {
      expect(rolesOf(method)).toEqual(['superadmin']);
    }
    // Chiqim marshruti rollari o'zgarmagan.
    expect(rolesOf('spendMoney')).toEqual(['superadmin', 'admin', 'manager']);
  });

  it('⭐ PATCH /cashbox/spend — expense_category_id finance ga uzatiladi (menejer ham); berilmasa payload avvalgidek', async () => {
    await request(http())
      .patch('/finance/cashbox/spend')
      .set('Idempotency-Key', 'k-spend-1')
      .send({ amount: 50_000, comment: 'Benzin', expense_category_id: '2' });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.spend' },
      expect.objectContaining({
        amount: 50_000,
        comment: 'Benzin',
        expense_category_id: '2',
        user_id: '9',
        created_by: '9',
        dedup_epoch: 'k-spend-1',
        financial_ledger: true,
      }),
    ]);

    await request(http())
      .patch('/finance/cashbox/spend')
      .set('x-test-role', 'manager')
      .send({ amount: 1_000, expense_category_id: '5' });
    expect(lastCall()?.[1]).toMatchObject({
      user_id: '13',
      cashbox_type: 'branch',
      expense_category_id: '5',
    });

    // Berilmasa — qiymat yo'q (RMQ JSON'ida kalit umuman ketmaydi).
    await request(http())
      .patch('/finance/cashbox/spend')
      .send({ amount: 1_000 });
    expect(lastCall()?.[1]?.expense_category_id).toBeUndefined();
    expect(
      JSON.parse(JSON.stringify(lastCall()?.[1])) as Record<string, unknown>,
    ).not.toHaveProperty('expense_category_id');
  });

  it('spend: raqam bo`lmagan expense_category_id → 400; kirim (fill) kategoriya qabul qilmaydi → 400', async () => {
    for (const value of ['abc', '', 5, '1.5']) {
      const bad = await request(http())
        .patch('/finance/cashbox/spend')
        .send({ amount: 1_000, expense_category_id: value });
      expect(bad.status).toBe(400);
    }
    const fill = await request(http())
      .patch('/finance/cashbox/fill')
      .send({ amount: 1_000, expense_category_id: '2' });
    expect(fill.status).toBe(400);
    expect(String(fill.body.message)).toContain('expense_category_id');
    expect(finance.send).not.toHaveBeenCalled();
  });
});
