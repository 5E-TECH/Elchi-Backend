import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * 4-tur, A guruhi (2026-10-14) — gateway kontrakti:
 *  - kfdfYDik — smena ochish/yopish `opened_by`/`closed_by` JWT'dan;
 *    GET /finance/shift/current;
 *  - 3PE0B03q — "O'tkazma manbasi" (`source_user_id`) 400 emas;
 *  - i75GDixP — PATCH /finance/cashbox/balance doimo `allow_negative:false`.
 */
describe('A4 — kassa/smena gateway kontrakti', () => {
  let app: INestApplication;
  const finance = {
    send: jest.fn(() => of({ statusCode: 200, data: { ok: true } })),
  };
  const branch = {
    send: jest.fn(() => of({ statusCode: 200, data: { id: '13' } })),
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

  beforeEach(() => {
    finance.send.mockClear();
    branch.send.mockClear();
  });

  const lastPayload = () =>
    (finance.send.mock.calls as unknown as Array<[unknown, any]>).at(-1)?.[1];

  describe('kfdfYDik — smena', () => {
    it('POST /finance/shift/close faqat {comment} bilan 2xx, closed_by JWT dan (ilgari 400)', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/shift/close')
        .send({ comment: 'audit-test' });

      expect(result.status).toBeLessThan(300);
      expect(finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.shift.close' },
        { comment: 'audit-test', closed_by: '9' },
      );
    });

    it('POST /finance/shift/close sanalgan summalar closing_balance_cash/card bo`lib uzatiladi; body closed_by e`tiborsiz', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/shift/close')
        .send({
          shift_id: '31',
          closed_by: '777',
          closing_balance_cash: 120000,
          closing_balance_card: 50000,
        });

      expect(result.status).toBeLessThan(300);
      expect(lastPayload()).toEqual({
        shift_id: '31',
        closed_by: '9',
        closing_balance_cash: 120000,
        closing_balance_card: 50000,
      });
    });

    it('POST /finance/shift/close manfiy sanalgan summa → 400', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/shift/close')
        .send({ closing_balance_cash: -5 });

      expect(result.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('POST /finance/shift/open bo`sh body bilan 201, opened_by JWT dan', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/shift/open')
        .send({});

      expect(result.status).toBe(201);
      expect(finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.shift.open' },
        { opened_by: '9' },
      );
    });

    it('POST /finance/shift/open eski frontend opened_by yuborsa ham 201, lekin JWT foydalanuvchisi yoziladi', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/shift/open')
        .send({ opened_by: '12345' });

      expect(result.status).toBe(201);
      expect(lastPayload()).toEqual({ opened_by: '9' });
    });

    it('GET /finance/shift/current → finance.shift.current; rollar shift bilan bir xil', async () => {
      const result = await request(app.getHttpServer()).get(
        '/finance/shift/current',
      );

      expect(result.status).toBe(200);
      expect(finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.shift.current' },
        {},
      );
      const descriptor = Object.getOwnPropertyDescriptor(
        FinanceGatewayController.prototype,
        'currentShift',
      );
      expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
        'superadmin',
        'admin',
        'registrator',
      ]);
    });
  });

  describe('3PE0B03q — o`tkazma manbasi', () => {
    it('POST /finance/cashbox/payment/market source_user_id bilan 201 (ilgari 400), transfer_source_user_id bo`lib uzatiladi', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/cashbox/payment/market')
        .send({
          market_id: '121',
          amount: 1000,
          payment_method: 'click',
          payment_date: '2026-10-14T10:00:00Z',
          comment: 'audit',
          source_user_id: '1',
        });

      expect(result.status).toBe(201);
      const payload = lastPayload();
      expect(payload).toMatchObject({
        market_id: '121',
        amount: 1000,
        payment_method: 'click',
        created_by: '9',
        transfer_source_user_id: '1',
      });
      // Kontragent maydoni (source_user_id = market) bilan aralashmaydi.
      expect(payload).not.toHaveProperty('source_user_id');
    });

    it('POST /finance/cashbox/payment/branch-to-main source_user_id bilan 201 (ilgari 400)', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/cashbox/payment/branch-to-main')
        .send({
          branch_id: '13',
          amount: 1000,
          payment_method: 'click',
          source_user_id: '1',
        });

      expect(result.status).toBe(201);
      expect(lastPayload()).toMatchObject({
        branch_id: '13',
        payment_method: 'click',
        transfer_source_user_id: '1',
      });
    });

    it('source_user_id raqam bo`lmasa → 400, finance chaqirilmaydi', async () => {
      const result = await request(app.getHttpServer())
        .post('/finance/cashbox/payment/market')
        .send({
          market_id: '121',
          amount: 1000,
          payment_method: 'click',
          source_user_id: 'abc',
        });

      expect(result.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });

    it('source_user_id yo`q bo`lsa payload avvalgidek (transfer_source_user_id yo`q)', async () => {
      await request(app.getHttpServer())
        .post('/finance/cashbox/payment/market')
        .send({ market_id: '121', amount: 1000, payment_method: 'cash' });

      expect(lastPayload()).not.toHaveProperty('transfer_source_user_id');
    });
  });

  describe('i75GDixP — PATCH /finance/cashbox/balance', () => {
    it('finance ga doimo allow_negative:false uzatiladi', async () => {
      const result = await request(app.getHttpServer())
        .patch('/finance/cashbox/balance')
        .send({
          user_id: '15',
          cashbox_type: 'branch',
          amount: 500000,
          operation_type: 'expense',
          source_type: 'correction',
        });

      expect(result.status).toBe(200);
      expect(lastPayload()).toMatchObject({
        source_type: 'correction',
        allow_negative: false,
      });
    });

    it('allow_negative ni klient yubora olmaydi (whitelist) → 400', async () => {
      const result = await request(app.getHttpServer())
        .patch('/finance/cashbox/balance')
        .send({
          user_id: '15',
          cashbox_type: 'branch',
          amount: 500000,
          operation_type: 'expense',
          source_type: 'sell',
          allow_negative: true,
        });

      expect(result.status).toBe(400);
      expect(finance.send).not.toHaveBeenCalled();
    });
  });
});
