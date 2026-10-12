import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FinancialSource_type } from '@app/common';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { FinanceGatewayController } from './finance-gateway.controller';

describe('b1QxU3qa - financial balance history source_type contract', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() =>
      of({ statusCode: 200, data: { items: [], rows: [], history: [] } }),
    ),
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
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => finance.send.mockClear());

  it.each(Object.values(FinancialSource_type))(
    'accepts %s and forwards the enum value',
    async (sourceType) => {
      const response = await request(app.getHttpServer())
        .get('/finance/financial-balance/history')
        .query({ source_type: sourceType });

      expect(response.status).toBe(200);
      expect(finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.financial_balance.history' },
        expect.objectContaining({ source_type: sourceType }),
      );
    },
  );

  it('rejects legacy sell with 400 before finance-service', async () => {
    const response = await request(app.getHttpServer())
      .get('/finance/financial-balance/history')
      .query({ source_type: 'sell' });

    expect(response.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });
});
