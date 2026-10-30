import 'reflect-metadata';
import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * T6 — to'lovni qaytarish / summasini tuzatish gateway kontrakti:
 *  - faqat superadmin (admin / menejer → 403); `Idempotency-Key` majburiy;
 *  - yangi tuzatish 201, o'sha kalit bilan takror 200 (`idempotent: true`);
 *  - correct-amount (kuryer to'lovi): asl qabul qiluvchi bo'yicha C4 (HQ)
 *    / C3 (filial) — mos kelmasa 409 NOT_CORRECTABLE, xizmat yo'q → 503;
 *  - BRANCH qabul qilgan to'lovda filial boshlig'i bildirishnomaga.
 */
describe('T6 — /finance/history/:id/{reverse,correct-amount} gateway', () => {
  let app: INestApplication;
  let controller: FinanceGatewayController;
  let context: Record<string, unknown> = {};
  let reply: Record<string, unknown> = {};
  const defaultFinance = (pattern: { cmd: string }) => {
    if (pattern.cmd === 'finance.payment_correction.context') {
      return of({ statusCode: 200, data: context });
    }
    return of(reply);
  };
  const finance = { send: jest.fn(defaultFinance) };
  const branch = {
    send: jest.fn(() => of({ data: { id: '15', manager_id: '77' } })),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

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
          const req = ctx
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user?: unknown }>();
          req.user = {
            sub: '1',
            username: 'u',
            roles: [req.headers['x-test-role'] ?? 'superadmin'],
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
    controller = module.get(FinanceGatewayController);
  });

  afterAll(async () => {
    await app?.close();
  });

  let hqCheck: jest.SpyInstance;
  let branchCheck: jest.SpyInstance;
  let placement: jest.SpyInstance;
  beforeEach(() => {
    finance.send.mockClear();
    finance.send.mockImplementation(defaultFinance);
    branch.send.mockClear();
    context = {
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'main',
      receiver_branch_id: null,
      courier_id: '301',
    };
    reply = {
      statusCode: 201,
      message: "To'lov qaytarildi",
      data: { correction: { id: '12' }, cashboxes: [], idempotent: false },
    };
    hqCheck = jest
      .spyOn(controller as never, 'assertHqCourierReceivable')
      .mockResolvedValue(undefined as never);
    branchCheck = jest
      .spyOn(controller as never, 'assertCourierInManagerBranch')
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(controller as never, 'resolveHqBranchId')
      .mockResolvedValue('1' as never);
    placement = jest
      .spyOn(controller as never, 'findBranchAssignmentOrThrow')
      .mockImplementation((() =>
        Promise.resolve({
          branch_id:
            context.receiver_cashbox_type === 'branch'
              ? String(context.receiver_branch_id)
              : '1',
          role: 'COURIER',
          name: '',
          phone_number: null,
        })) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  const correctionCall = () =>
    (
      finance.send.mock.calls as unknown as Array<
        [{ cmd: string }, Record<string, unknown>]
      >
    ).find(
      ([p]) =>
        p.cmd.startsWith('finance.payment_correction.') &&
        p.cmd !== 'finance.payment_correction.context',
    );

  it('⭐ reverse: 201 yangi, o`sha kalit takrori 200; payload JWT dan', async () => {
    const res = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'k-1')
      .send({ reason: 'Xato kiritildi' });
    expect(res.status).toBe(201);
    expect(correctionCall()).toEqual([
      { cmd: 'finance.payment_correction.reverse' },
      {
        history_id: '845',
        reason: 'Xato kiritildi',
        idempotency_key: 'k-1',
        requester_id: '1',
        requester_roles: ['superadmin'],
        notify_user_ids: [],
      },
    ]);
    // Qaytarishda (yangi to'lov yo'q) joylashuv tekshiruvi kerak emas.
    expect(hqCheck).not.toHaveBeenCalled();

    reply = { ...reply, statusCode: 200, data: { idempotent: true } };
    const again = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'k-1')
      .send({ reason: 'Xato kiritildi' });
    expect(again.status).toBe(200);
    expect(again.body.data.idempotent).toBe(true);
  });

  it('kalitsiz → 400 IDEMPOTENCY_KEY_REQUIRED; admin / menejer → 403; sabab < 5 → 400', async () => {
    const noKey = await request(http())
      .post('/finance/history/845/reverse')
      .send({ reason: 'Xato kiritildi' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const role of ['admin', 'manager', 'registrator']) {
      const res = await request(http())
        .post('/finance/history/845/correct-amount')
        .set('x-test-role', role)
        .set('Idempotency-Key', 'k-2')
        .send({ reason: 'Xato kiritildi', new_amount: 100 });
      expect(res.status).toBe(403);
    }
    const short = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'k-3')
      .send({ reason: 'abc' });
    expect(short.status).toBe(400);
    expect(correctionCall()).toBeUndefined();
  });

  it('⭐ correct-amount, HQ qabul: C4 tekshiriladi; rad → 409 NOT_CORRECTABLE, finance chaqirilmaydi', async () => {
    const ok = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-4')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(ok.status).toBe(201);
    expect(hqCheck).toHaveBeenCalledWith('301', expect.anything());

    finance.send.mockClear();
    hqCheck.mockRejectedValueOnce(
      new BadRequestException('Kuryerda filialga tegishli savdo bor'),
    );
    const bad = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-5')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('NOT_CORRECTABLE');
    expect(correctionCall()).toBeUndefined();

    hqCheck.mockRejectedValueOnce(new ServiceUnavailableException('x'));
    const down = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-6')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(down.status).toBe(503);
  });

  it('⭐ correct-amount, filial qabul: C3 asl filial bilan; filial boshlig`i xabarga', async () => {
    context = {
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'branch',
      receiver_branch_id: '15',
      courier_id: '301',
    };
    const ok = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-7')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(ok.status).toBe(201);
    expect(branchCheck).toHaveBeenCalledWith('301', '15', expect.anything());
    expect(hqCheck).not.toHaveBeenCalled();
    expect(correctionCall()?.[1]).toMatchObject({
      new_amount: 50000,
      notify_user_ids: ['77'],
    });

    branchCheck.mockRejectedValueOnce(new ForbiddenException('boshqa filial'));
    const bad = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-8')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('NOT_CORRECTABLE');
  });

  it('marketga to`lov tahriri — kuryer tekshiruvi yo`q', async () => {
    context = {
      payment_kind: 'market_payment',
      receiver_cashbox_type: 'main',
      receiver_branch_id: null,
      courier_id: null,
    };
    const ok = await request(http())
      .post('/finance/history/900/correct-amount')
      .set('Idempotency-Key', 'k-9')
      .send({ reason: 'Summa xato', new_amount: 10 });
    expect(ok.status).toBe(201);
    expect(hqCheck).not.toHaveBeenCalled();
    expect(branchCheck).not.toHaveBeenCalled();
  });

  it('⭐ B: kuryer boshqa filialga o`tgan — reverse ham, correct-amount ham 409 COURIER_MOVED', async () => {
    placement.mockResolvedValue({ branch_id: '22', role: 'COURIER' });
    const edit = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'm-edit')
      .send({ reason: 'Xato kiritildi', new_amount: 100 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('COURIER_MOVED');
    expect(hqCheck).not.toHaveBeenCalled();
    const res = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'm-r2')
      .send({ reason: 'Xato kiritildi' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COURIER_MOVED');
    expect(correctionCall()).toBeUndefined();
  });

  it('E2: o`sha kalit bilan takror (context.replay) — joylashuv tekshiruvisiz finance ga', async () => {
    context = { ...context, replay: true };
    placement.mockResolvedValue({ branch_id: '22', role: 'COURIER' });
    hqCheck.mockRejectedValue(new BadRequestException('x'));
    reply = { statusCode: 200, data: { idempotent: true } };
    const res = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-replay')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(res.status).toBe(200);
    expect(res.body.data.idempotent).toBe(true);
    expect(placement).not.toHaveBeenCalled();
    const ctxCall = (
      finance.send.mock.calls as unknown as Array<
        [{ cmd: string }, Record<string, unknown>]
      >
    ).find(([p]) => p.cmd === 'finance.payment_correction.context');
    expect(ctxCall?.[1]).toEqual({
      history_id: '845',
      idempotency_key: 'k-replay',
    });
  });

  it('E3: kodsiz xato (RMQ / identity bo`sh) — 503, 409 emas; joylashuvni o`qib bo`lmasa — 503', async () => {
    hqCheck.mockRejectedValueOnce(new Error('connection closed'));
    const res = await request(http())
      .post('/finance/history/845/correct-amount')
      .set('Idempotency-Key', 'k-e3')
      .send({ reason: 'Summa xato', new_amount: 50000 });
    expect(res.status).toBe(503);
    placement.mockRejectedValueOnce(new Error('branch down'));
    const down = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'k-e3b')
      .send({ reason: 'Xato kiritildi' });
    expect(down.status).toBe(503);
  });

  it('GET /history/:id (superadmin): kuryer ko`chgan — correctable.allowed=false, code COURIER_MOVED', async () => {
    placement.mockResolvedValue({ branch_id: '22', role: 'COURIER' });
    finance.send.mockImplementation((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'finance.payment_correction.context'
          ? { data: context }
          : {
              statusCode: 200,
              data: {
                id: '845',
                correctable: { allowed: true, deadline: 'x', window_days: 30 },
              },
            },
      ),
    );
    const res = await request(http()).get('/finance/history/845');
    expect(res.body.data.correctable).toMatchObject({
      allowed: false,
      code: 'COURIER_MOVED',
    });
  });
  it('5: COURIER_MOVED — filial 15 qabul qilgan, kuryer 22 da; biriktiruv yo`q; HQ filiali = HQ — o`tadi', async () => {
    context = {
      payment_kind: 'courier_payment',
      receiver_cashbox_type: 'branch',
      receiver_branch_id: '15',
      courier_id: '301',
    };
    placement.mockResolvedValueOnce({
      branch_id: '22',
      role: 'COURIER',
    });
    const moved = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'cm-a')
      .send({ reason: 'Xato kiritildi' });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe('COURIER_MOVED');

    placement.mockResolvedValueOnce(null);
    const none = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'cm-b')
      .send({ reason: 'Xato kiritildi' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('COURIER_MOVED');

    // HQ filialining BRANCH kassasi (id 1 = HQ), kuryer HQ da — o'tadi.
    context = { ...context, receiver_branch_id: '1' };
    placement.mockResolvedValueOnce({
      branch_id: '1',
      role: 'COURIER',
    });
    const ok = await request(http())
      .post('/finance/history/845/reverse')
      .set('Idempotency-Key', 'cm-c')
      .send({ reason: 'Xato kiritildi' });
    expect(ok.status).toBe(201);
    expect(correctionCall()?.[0]).toEqual({
      cmd: 'finance.payment_correction.reverse',
    });
  });

  it('7: GET /history/:id — ko`rsatish uchun branch so`rovlari qisqa (≤1500 ms) muddat bilan', async () => {
    finance.send.mockImplementation((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'finance.payment_correction.context'
          ? { data: context }
          : {
              statusCode: 200,
              data: {
                id: '845',
                correctable: { allowed: true, deadline: 'x', window_days: 30 },
              },
            },
      ),
    );
    await request(http()).get('/finance/history/845');
    expect(placement).toHaveBeenCalledWith('301', expect.anything(), 1500);
  });
});
