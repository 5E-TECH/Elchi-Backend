import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { FinanceGatewayController } from './finance-gateway.controller';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * AG1Mlikw (T6-BE-1, In Test topilmalari):
 *  - `payment_reversal` faqat ichki tur: `PATCH /finance/cashbox/balance` 400,
 *    finance'ga yetib bormaydi; filtr (`source_types`) esa ishlaydi;
 *  - `window_days` butun son: `true` (DTO transformida 1 bo'lib ketardi) 400.
 */
describe('AG1Mlikw — gateway validatsiyasi', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn((_pattern: { cmd: string }, payload: unknown) =>
      of({ statusCode: 200, data: payload }),
    ),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const balance = (source_type: string) => ({
    cashbox_id: '1',
    amount: 1000,
    operation_type: 'income',
    source_type,
    comment: 'sinov',
  });

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
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
          req.user = { sub: '1', username: 'u', roles: ['superadmin'] };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new UzValidationPipe({
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

  beforeEach(() => finance.send.mockClear());

  it('⭐ PATCH cashbox/balance `payment_reversal` → 400, finance chaqirilmaydi', async () => {
    await request(http())
      .patch('/finance/cashbox/balance')
      .send(balance('payment_reversal'))
      .expect(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('boshqa turlar avvalgidek o`tadi (`allow_negative: false`)', async () => {
    await request(http())
      .patch('/finance/cashbox/balance')
      .send(balance('correction'))
      .expect(200);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.update_balance' },
      expect.objectContaining({
        source_type: 'correction',
        allow_negative: false,
      }),
    );
  });

  it.each([[true], [false], ['7'], [[7]], [0], [366], [1.5], [null]])(
    '⭐ PATCH payment-corrections/settings window_days=%j → 400',
    async (window_days) => {
      await request(http())
        .patch('/finance/payment-corrections/settings')
        .send({ window_days })
        .expect(400);
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it.each([[1], [10], [365]])(
    'PATCH payment-corrections/settings window_days=%j → 200',
    async (window_days) => {
      await request(http())
        .patch('/finance/payment-corrections/settings')
        .send({ window_days })
        .expect(200);
      expect(finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.payment_correction.settings.update' },
        expect.objectContaining({ window_days }),
      );
    },
  );
});
