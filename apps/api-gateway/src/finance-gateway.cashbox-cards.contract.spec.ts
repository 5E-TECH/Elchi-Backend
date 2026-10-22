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
 * 3PE0B03q (UZOQ MUDDAT) — asosiy kassa NOMLI kartalari gateway kontrakti
 * (BeePost `cashbox_card` porti): marshrutlar, whitelist, JWT'dan
 * `created_by`, `Idempotency-Key` → `dedup_epoch`, to'lovlarda `card_id`.
 */
describe('3PE0B03q — /finance/cashbox/cards gateway kontrakti', () => {
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
  });

  const lastCall = () =>
    (finance.send.mock.calls as unknown as Array<[{ cmd: string }, any]>).at(
      -1,
    );

  it('GET /finance/cashbox/cards → finance.cashbox.cards.list (include_inactive)', async () => {
    const res = await request(app.getHttpServer()).get(
      '/finance/cashbox/cards?include_inactive=true',
    );
    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.list' },
      { include_inactive: true },
    ]);
  });

  it('POST /finance/cashbox/cards — created_by JWT dan; nom bo`sh → 400', async () => {
    const ok = await request(app.getHttpServer())
      .post('/finance/cashbox/cards')
      .send({ name: 'Humo 8600' });
    expect(ok.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.create' },
      { name: 'Humo 8600', created_by: '9' },
    ]);

    finance.send.mockClear();
    const bad = await request(app.getHttpServer())
      .post('/finance/cashbox/cards')
      .send({ name: '' });
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('POST /finance/cashbox/cards/transfer — Idempotency-Key → dedup_epoch; izoh majburiy; summa > 0', async () => {
    const ok = await request(app.getHttpServer())
      .post('/finance/cashbox/cards/transfer')
      .set('Idempotency-Key', 'k-1')
      .send({
        from_card_id: '1',
        to_card_id: '3',
        amount: 500000,
        comment: 'Humo ga',
      });
    expect(ok.status).toBe(201);
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.transfer' },
      {
        from_card_id: '1',
        to_card_id: '3',
        amount: 500000,
        comment: 'Humo ga',
        created_by: '9',
        dedup_epoch: 'k-1',
      },
    ]);

    finance.send.mockClear();
    for (const body of [
      { from_card_id: '1', to_card_id: '3', amount: 500000 },
      { from_card_id: '1', to_card_id: '3', amount: 0, comment: 'x' },
      { from_card_id: 'a', to_card_id: '3', amount: 1, comment: 'x' },
    ]) {
      const bad = await request(app.getHttpServer())
        .post('/finance/cashbox/cards/transfer')
        .send(body);
      expect(bad.status).toBe(400);
    }
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('POST /finance/cashbox/cards/convert — faqat card_to_cash / cash_to_card; kalitsiz — dedup_epoch yo`q', async () => {
    const ok = await request(app.getHttpServer())
      .post('/finance/cashbox/cards/convert')
      .send({
        type: 'card_to_cash',
        card_id: '3',
        amount: 10000,
        comment: 'bankomat',
      });
    expect(ok.status).toBe(201);
    expect(lastCall()?.[1]).toEqual({
      type: 'card_to_cash',
      card_id: '3',
      amount: 10000,
      comment: 'bankomat',
      created_by: '9',
    });

    finance.send.mockClear();
    const bad = await request(app.getHttpServer())
      .post('/finance/cashbox/cards/convert')
      .send({
        type: 'card_to_card',
        card_id: '3',
        amount: 10000,
        comment: 'x',
      });
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('PATCH /:id va /:id/status, GET /movements va /:id/ledger — to`g`ri cmd; noto`g`ri id → 400', async () => {
    await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3')
      .send({ name: 'Uzcard' });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.rename' },
      { id: '3', name: 'Uzcard', updated_by: '9' },
    ]);
    await request(app.getHttpServer())
      .patch('/finance/cashbox/cards/3/status')
      .send({ is_active: false });
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.set_active' },
      { id: '3', is_active: false, updated_by: '9' },
    ]);
    await request(app.getHttpServer()).get(
      '/finance/cashbox/cards/movements?card_id=3&page=2',
    );
    expect(lastCall()).toEqual([
      { cmd: 'finance.cashbox.cards.movements' },
      { card_id: '3', page: 2, limit: undefined },
    ]);
    await request(app.getHttpServer()).get(
      '/finance/cashbox/cards/3/ledger?from_date=2026-10-01',
    );
    expect(lastCall()?.[0]).toEqual({ cmd: 'finance.cashbox.cards.ledger' });
    expect(lastCall()?.[1]).toMatchObject({ id: '3', from_date: '2026-10-01' });

    finance.send.mockClear();
    const bad = await request(app.getHttpServer()).get(
      '/finance/cashbox/cards/abc/ledger',
    );
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('to`lovlarda card_id: marketga, filialdan HQ ga va qo`lda chiqim finance ga uzatiladi; raqam bo`lmasa 400', async () => {
    await request(app.getHttpServer())
      .post('/finance/cashbox/payment/market')
      .send({
        market_id: '121',
        amount: 1000,
        payment_method: 'click',
        card_id: '3',
      });
    expect(lastCall()?.[1]).toMatchObject({ market_id: '121', card_id: '3' });

    await request(app.getHttpServer())
      .post('/finance/cashbox/payment/branch-to-main')
      .send({
        branch_id: '13',
        amount: 1000,
        payment_method: 'click',
        card_id: '3',
      });
    expect(lastCall()?.[1]).toMatchObject({ branch_id: '13', card_id: '3' });

    await request(app.getHttpServer())
      .patch('/finance/cashbox/spend')
      // (2026-10-22) HTTP chiqimda kategoriya majburiy.
      .send({
        amount: 1000,
        type: 'click',
        card_id: '3',
        expense_category_id: '2',
      });
    expect(lastCall()?.[1]).toMatchObject({ amount: 1000, card_id: '3' });

    finance.send.mockClear();
    const bad = await request(app.getHttpServer())
      .patch('/finance/cashbox/fill')
      .send({ amount: 1000, type: 'click', card_id: 'x' });
    expect(bad.status).toBe(400);
    expect(finance.send).not.toHaveBeenCalled();
  });

  it('PATCH /finance/cashbox/balance card_id qabul qilmaydi (whitelist) → 400', async () => {
    const body = {
      user_id: '0',
      cashbox_type: 'main',
      amount: 1,
      operation_type: 'income',
      source_type: 'correction',
    };
    const ok = await request(app.getHttpServer())
      .patch('/finance/cashbox/balance')
      .send(body);
    expect(ok.status).toBeLessThan(300);

    const res = await request(app.getHttpServer())
      .patch('/finance/cashbox/balance')
      .send({ ...body, card_id: '3' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('card_id');
  });

  it('rollar: kartalar — faqat superadmin/admin (BeePost bilan bir xil)', () => {
    for (const method of [
      'listCashboxCards',
      'createCashboxCard',
      'listCashboxCardMovements',
      'getCashboxCardLedger',
      'renameCashboxCard',
      'setCashboxCardStatus',
      'transferCashboxCards',
      'convertCashboxCard',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(
        FinanceGatewayController.prototype,
        method,
      );
      expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
        'superadmin',
        'admin',
      ]);
    }
  });
});
