import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

describe('cSNJN7GP - manual financial balance entry contract', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: '1' } })),
  };
  const body = { amount: -1, source_type: 'manual_expense' };

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
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user: unknown } };
        }) => {
          context.switchToHttp().getRequest().user = { sub: '9' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => finance.send.mockClear());

  it('passes the original Idempotency-Key to finance-service', async () => {
    const response = await request(app.getHttpServer())
      .post('/finance/financial-balance/entries')
      .set('Idempotency-Key', 'manual-1')
      .send(body);

    expect(response.status).toBe(201);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.financial_balance.record' },
      { ...body, created_by: '9', dedup_key: 'manual-1' },
    );
  });

  it('rejects missing Idempotency-Key with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/finance/financial-balance/entries')
      .send(body);

    expect(response.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('rejects amount beyond numeric bounds with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/finance/financial-balance/entries')
      .set('Idempotency-Key', 'manual-2')
      .send({ ...body, amount: 1e30 });

    expect(response.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('preserves the explicit zero-amount skipped response', async () => {
    finance.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        message: 'zero amount - ledger entry skipped',
        data: null,
      }),
    );
    const response = await request(app.getHttpServer())
      .post('/finance/financial-balance/entries')
      .set('Idempotency-Key', 'manual-zero')
      .send({ ...body, amount: 0 });

    expect(response.status).toBe(200);
    expect(response.body.statusCode).toBe(200);
    expect(response.body.message).toMatch(/zero amount/);
  });
});
