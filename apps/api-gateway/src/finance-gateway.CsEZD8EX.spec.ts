import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * CsEZD8EX (T6-BE-4) — filial boshliqlari `branch_users` dan (MANAGER):
 * `POST /managers` eski `branches.manager_id` ni to'ldirmaydi, xabar
 * menejerga bormas edi. Eski ustunda qiymat bo'lsa ham ishlaydi, takror
 * yuborilmaydi; o'qish xatosi to'lov tuzatishni yiqitmaydi.
 */
describe('CsEZD8EX — BRANCH to`lovida filial menejerlari xabar oladi', () => {
  let app: INestApplication;
  let context: Record<string, unknown>;
  let users: () => unknown;
  let branchRow: () => unknown;
  const finance = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'finance.payment_correction.context'
        ? of({ statusCode: 200, data: context })
        : of({ statusCode: 201, data: { idempotent: false } }),
    ),
  };
  const branch = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.user.find_by_branch' ? users() : branchRow(),
    ),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  const notified = async () => {
    await request(http())
      .post('/finance/history/5/reverse')
      .set('Idempotency-Key', 'k1')
      .send({ reason: 'Xato kiritilgan' })
      .expect(201);
    const call = finance.send.mock.calls.find(
      ([pattern]) => pattern.cmd === 'finance.payment_correction.reverse',
    ) as unknown as [unknown, { notify_user_ids: string[] }];
    return call[1].notify_user_ids;
  };

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
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
          req.user = { sub: '1', username: 'u', roles: ['superadmin'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
    const gateway = module.get<FinanceGatewayController>(
      FinanceGatewayController,
    );
    jest
      .spyOn(gateway as never, 'assertCourierNotMoved')
      .mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    finance.send.mockClear();
    branch.send.mockClear();
    context = {
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'branch',
      receiver_branch_id: '7',
      courier_id: '22',
    };
    users = () =>
      of({
        data: [
          { user_id: '77', role: 'MANAGER', branch_id: '7' },
          { user_id: '78', role: 'manager', branch_id: '7' },
          { user_id: '22', role: 'COURIER', branch_id: '7' },
          { user_id: '30', role: 'REGISTRATOR', branch_id: '7' },
          { user_id: '79', role: 'MANAGER', isDeleted: true },
          { user_id: 'x', role: 'MANAGER' },
        ],
      });
    branchRow = () => of({ data: { id: '7', manager_id: null } });
  });

  it('⭐ eski ustun bo`sh — branch_users dagi MANAGER lar', async () => {
    expect(await notified()).toEqual(['77', '78']);
    expect(branch.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_branch' },
      expect.objectContaining({ branch_id: '7' }),
    );
  });

  it('eski ustun branch_users dagi menejer bilan bir xil — takror yo`q', async () => {
    branchRow = () => of({ data: { id: '7', manager_id: '77' } });
    expect(await notified()).toEqual(['77', '78']);
  });

  it('eski ustunda boshqa menejer — u ham oladi', async () => {
    branchRow = () => of({ data: { id: '7', manager_id: 90 } });
    expect(await notified()).toEqual(['77', '78', '90']);
  });

  it('branch_users o`qilmadi — eski ustun ishlaydi; bo`sh javob ham', async () => {
    branchRow = () => of({ data: { id: '7', manager_id: '90' } });
    users = () => throwError(() => new Error('rmq'));
    expect(await notified()).toEqual(['90']);
    finance.send.mockClear();
    users = () => of({ data: null });
    expect(await notified()).toEqual(['90']);
  });

  it('branch.find_by_id yiqildi — branch_users ishlaydi', async () => {
    branchRow = () => throwError(() => new Error('rmq'));
    expect(await notified()).toEqual(['77', '78']);
  });

  it('ikkalasi yiqildi — tuzatish to`xtamaydi, ro`yxat bo`sh', async () => {
    branchRow = () => throwError(() => new Error('rmq'));
    users = () => throwError(() => new Error('rmq'));
    expect(await notified()).toEqual([]);
  });

  it('MAIN qabul qilgan — filial o`qilmaydi, faqat kuryer', async () => {
    context = {
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'main',
      receiver_branch_id: null,
      courier_id: '22',
    };
    expect(await notified()).toEqual([]);
    expect(branch.send).not.toHaveBeenCalled();
  });
});
