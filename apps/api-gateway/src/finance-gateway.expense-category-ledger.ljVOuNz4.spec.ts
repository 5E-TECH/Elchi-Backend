import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * ljVOuNz4 — chiqimda "nima uchun?": gateway kontrakti.
 *
 *  (A) kassa: `PATCH /cashbox/spend` kategoriyasiz → 400, `/cashbox/fill`
 *      kategoriya so'ramaydi; izoh majburiyligi `CASHBOX_SPEND_COMMENT_REQUIRED`
 *      kaliti bilan (sukut — 2026-10-22 xulqi, izoh ixtiyoriy).
 *  (B) daftar: `POST /financial-balance/entries` — manba bo'yicha qoida.
 *      Majburiylik `FINANCIAL_ENTRY_CATEGORY_REQUIRED` kaliti bilan: hozirgi FE
 *      `{ amount, source_type, comment }` yuboradi, sukut o'chiq — u buzilmaydi.
 */
describe('ljVOuNz4 — chiqim kategoriyasi: gateway kontrakti', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: '1' } })),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  const ORIGINAL = {
    entry: process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED,
    comment: process.env.CASHBOX_SPEND_COMMENT_REQUIRED,
  };

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
          context.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '9',
            username: 'u',
            roles: ['superadmin'],
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
    for (const [key, value] of [
      ['FINANCIAL_ENTRY_CATEGORY_REQUIRED', ORIGINAL.entry],
      ['CASHBOX_SPEND_COMMENT_REQUIRED', ORIGINAL.comment],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    finance.send.mockClear();
    delete process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED;
    delete process.env.CASHBOX_SPEND_COMMENT_REQUIRED;
  });

  const lastPayload = () =>
    (
      finance.send.mock.calls.at(-1) as unknown as [
        { cmd: string },
        Record<string, unknown>,
      ]
    )[1];
  const lastCmd = () =>
    (finance.send.mock.calls.at(-1) as unknown as [{ cmd: string }])[0].cmd;

  const entry = (body: Record<string, unknown>) =>
    request(http())
      .post('/finance/financial-balance/entries')
      .set('Idempotency-Key', 'k-1')
      .send(body);

  describe('(B) POST /finance/financial-balance/entries', () => {
    const expense = { amount: -50_000, comment: 'Ijara oktabr' };

    describe('FINANCIAL_ENTRY_CATEGORY_REQUIRED=on', () => {
      beforeEach(() => {
        process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED = 'on';
      });

      it('manual_expense kategoriyasiz → 400, finance chaqirilmaydi', async () => {
        const res = await entry({ ...expense, source_type: 'manual_expense' });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain(
          'Xarajat kategoriyasini tanlang',
        );
        expect(finance.send).not.toHaveBeenCalled();
      });

      it('bills kategoriyasiz → 400', async () => {
        const res = await entry({ ...expense, source_type: 'bills' });
        expect(res.status).toBe(400);
        expect(finance.send).not.toHaveBeenCalled();
      });

      it('salary so`ralmaydi: kategoriyasiz 201 (T5: eski mijoz buzilmaydi)', async () => {
        const res = await entry({ ...expense, source_type: 'salary' });
        expect(res.status).toBe(201);
      });

      it.each(['correction', 'manual_income'])(
        '%s kategoriyasiz 201',
        async (source_type) => {
          const res = await entry({
            amount: 10_000,
            comment: 'x',
            source_type,
          });
          expect(res.status).toBe(201);
        },
      );
    });

    it('sukut (kalit o`chiq): hozirgi FE payload`i buzilmaydi — 201', async () => {
      const res = await entry({ ...expense, source_type: 'manual_expense' });
      expect(res.status).toBe(201);
      expect(lastPayload().expense_category).toBeUndefined();
    });

    it('18 talik ro`yxatdan qiymat finance`ga o`tadi', async () => {
      const res = await entry({
        ...expense,
        source_type: 'manual_expense',
        expense_category: 'fuel',
      });
      expect(res.status).toBe(201);
      expect(lastPayload()).toMatchObject({ expense_category: 'fuel' });
    });

    it.each([undefined, 'on'])(
      'ro`yxatdan tashqari qiymat → 400 (kalit=%s)',
      async (flag) => {
        if (flag) process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED = flag;
        const res = await entry({
          ...expense,
          source_type: 'manual_expense',
          expense_category: 'foo',
        });
        expect(res.status).toBe(400);
        expect(finance.send).not.toHaveBeenCalled();
      },
    );

    it.each(['utilities', 'communication', 'rent', 'tax', 'bank_fee', 'other'])(
      'bills: cheklangan ro`yxatdagi %s → 201',
      async (expense_category) => {
        const res = await entry({
          ...expense,
          source_type: 'bills',
          expense_category,
        });
        expect(res.status).toBe(201);
      },
    );

    it.each(['fuel', 'salary', 'food'])(
      'bills: cheklovdan tashqari %s → 400',
      async (expense_category) => {
        const res = await entry({
          ...expense,
          source_type: 'bills',
          expense_category,
        });
        expect(res.status).toBe(400);
        expect(finance.send).not.toHaveBeenCalled();
      },
    );
  });

  describe('(A) PATCH /finance/cashbox/spend', () => {
    const spend = (body: Record<string, unknown>) =>
      request(http()).patch('/finance/cashbox/spend').send(body);

    it('kategoriyasiz → 400 (jimgina o`tib ketmaydi)', async () => {
      const res = await spend({ amount: 1000, comment: 'Benzin' });
      expect(res.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it.each([{ expense_category_id: 'foo' }, { expense_category: 'foo' }])(
      'ro`yxatdan tashqari qiymat %j → 400',
      async (extra) => {
        const res = await spend({ amount: 1000, comment: 'Benzin', ...extra });
        expect(res.status).toBe(400);
        expect(finance.send).not.toHaveBeenCalled();
      },
    );

    it('izoh matni o`zgarmay o`tadi', async () => {
      const comment = '  AI-92, 40 l  ';
      const res = await spend({
        amount: 1000,
        comment,
        expense_category_id: '2',
      });
      expect(res.status).toBe(200);
      expect(lastPayload()).toMatchObject({
        comment,
        expense_category_id: '2',
        financial_ledger: true,
      });
    });

    it('sukut: izoh ixtiyoriy (ega 2026-10-22, hozirgi FE bo`sh izohni yubormaydi)', async () => {
      const res = await spend({ amount: 1000, expense_category_id: '2' });
      expect(res.status).toBe(200);
    });

    it.each([undefined, '', '   '])(
      'CASHBOX_SPEND_COMMENT_REQUIRED=on: bo`sh izoh (%j) → 400',
      async (comment) => {
        process.env.CASHBOX_SPEND_COMMENT_REQUIRED = 'on';
        const res = await spend({
          amount: 1000,
          expense_category_id: '2',
          ...(comment === undefined ? {} : { comment }),
        });
        expect(res.status).toBe(400);
        expect(finance.send).not.toHaveBeenCalled();
      },
    );

    it('CASHBOX_SPEND_COMMENT_REQUIRED=on: izoh bilan o`tadi', async () => {
      process.env.CASHBOX_SPEND_COMMENT_REQUIRED = 'on';
      const res = await spend({
        amount: 1000,
        comment: 'Benzin',
        expense_category_id: '2',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('(A) PATCH /finance/cashbox/fill — kirim o`zgarmagan', () => {
    const fill = (body: Record<string, unknown>) =>
      request(http()).patch('/finance/cashbox/fill').send(body);

    it.each([undefined, 'on'])(
      'kategoriya va izoh so`ralmaydi (kalitlar=%s)',
      async (flag) => {
        if (flag) {
          process.env.CASHBOX_SPEND_COMMENT_REQUIRED = flag;
          process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED = flag;
        }
        const res = await fill({ amount: 1000 });
        expect(res.status).toBe(200);
        expect(lastCmd()).toBe('finance.cashbox.fill');
      },
    );

    it('kategoriya yuborilsa 400 (whitelist)', async () => {
      const res = await fill({ amount: 1000, expense_category_id: '2' });
      expect(res.status).toBe(400);
    });
  });

  describe('ro`yxatlar va hisobot', () => {
    it.each(['fuel', 'none'])(
      'GET /financial-balance/history?expense_category=%s finance`ga o`tadi',
      async (value) => {
        const res = await request(http()).get(
          `/finance/financial-balance/history?expense_category=${value}`,
        );
        expect(res.status).toBe(200);
        expect(lastCmd()).toBe('finance.financial_balance.history');
        expect(lastPayload()).toMatchObject({ expense_category: value });
      },
    );

    it('GET /financial-balance/history?expense_category=foo → 400', async () => {
      const res = await request(http()).get(
        '/finance/financial-balance/history?expense_category=foo',
      );
      expect(res.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it.each(['5', 'none'])(
      'GET /history?expense_category_id=%s finance`ga o`tadi',
      async (value) => {
        const res = await request(http()).get(
          `/finance/history?expense_category_id=${value}`,
        );
        expect(res.status).toBe(200);
        expect(lastCmd()).toBe('finance.history.find_all');
        expect(lastPayload()).toMatchObject({ expense_category_id: value });
      },
    );

    it('GET /history?expense_category_id=abc → 400', async () => {
      const res = await request(http()).get(
        '/finance/history?expense_category_id=abc',
      );
      expect(res.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('GET /financial-balance/expense-report — RMQ, sana taxalluslari', async () => {
      const res = await request(http()).get(
        '/finance/financial-balance/expense-report?fromDate=2026-10-01&to_date=2026-10-31',
      );
      expect(res.status).toBe(200);
      expect(lastCmd()).toBe('finance.financial_balance.expense_report');
      expect(lastPayload()).toEqual({
        from_date: '2026-10-01',
        to_date: '2026-10-31',
      });
    });
  });
});
