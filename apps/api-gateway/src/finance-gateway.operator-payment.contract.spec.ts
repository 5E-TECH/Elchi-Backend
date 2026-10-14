import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

describe('2DCQKd37 - POST /finance/operator-payments kontrakti', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: '1' } })),
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
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => any };
        }) => {
          context.switchToHttp().getRequest().user = {
            sub: '9',
            roles: ['superadmin'],
          };
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

  it('note bilan 201 va izoh finance-service ga uzatiladi', async () => {
    const result = await request(app.getHttpServer())
      .post('/finance/operator-payments')
      .send({ operator_id: '42', amount: 1000, note: 'Oylik' });

    expect(result.status).toBe(201);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.payment.create' },
      { operator_id: '42', amount: 1000, note: 'Oylik', paid_by_id: '9' },
    );
  });

  it('FJVqcUTv: Idempotency-Key bo`lsa finance-service ga idempotency_key bo`lib uzatiladi', async () => {
    const result = await request(app.getHttpServer())
      .post('/finance/operator-payments')
      .set('Idempotency-Key', ' fe-op-1 ')
      .send({ operator_id: '42', amount: 1000, note: 'Oylik' });

    expect(result.status).toBe(201);
    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.operator.payment.create' },
      {
        operator_id: '42',
        amount: 1000,
        note: 'Oylik',
        paid_by_id: '9',
        idempotency_key: 'fe-op-1',
      },
    );
  });

  it('comment bilan 400 va finance-service chaqirilmaydi', async () => {
    const result = await request(app.getHttpServer())
      .post('/finance/operator-payments')
      .send({ operator_id: '42', amount: 1000, comment: 'Oylik' });

    expect(result.status).toBe(400);
    expect(result.body.message).toContain('property comment should not exist');
    expect(finance.send).not.toHaveBeenCalled();
  });
});
