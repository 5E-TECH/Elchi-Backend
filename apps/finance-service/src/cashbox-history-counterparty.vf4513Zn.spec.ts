import { of, throwError } from 'rxjs';
import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';

/**
 * vf4513Zn — `getCashboxByUserId` (GET /finance/cashbox/my-cashbox, menejer
 * `cashbox/main`, `cashbox/user/:id/main`) tarixida KONTRAGENT va kassa EGASI:
 *  - `source_user` — COURIER_PAYMENT / MARKET_PAYMENT qatorida (menejer filial
 *    kassasidagi «Kuryerdan filialga o'tkazma» — kuryer ismi);
 *  - `created_by_user` — amalni kiritgan xodim;
 *  - `cashbox.user` — faqat kuryer/market kassasida; BRANCH/MAIN `user_id` si
 *    odam emas (CODE-08) — null va identity'dan so'ralmaydi;
 *  - kuryer kassasida `payment_ack` saqlanadi (2crjWf7v).
 */
describe('vf4513Zn — my-cashbox tarixida kontragent (source_user) va kassa egasi (cashbox.user)', () => {
  const users: Record<string, Record<string, unknown>> = {
    '25': { id: '25', name: 'Menejer Urgut', role: 'manager' },
    '26': { id: '26', name: 'Kuryer Ali', role: 'courier' },
    '37': { id: '37', name: 'TEST market', role: 'market' },
    '1': { id: '1', name: 'Superadmin', role: 'superadmin' },
  };

  const make = (
    cashbox: Record<string, unknown>,
    history: Array<Record<string, unknown>>,
    identitySend?: jest.Mock,
  ) => {
    const self = Object.create(FinanceServiceService.prototype) as Record<
      string,
      unknown
    >;
    const identity = {
      send:
        identitySend ??
        jest.fn((_pattern: unknown, payload: { id: string }) =>
          of({ statusCode: 200, data: users[String(payload.id)] ?? null }),
        ),
    };
    self.cashboxRepo = { findOne: jest.fn().mockResolvedValue(cashbox) };
    self.historyRepo = {
      find: jest.fn().mockResolvedValue(history),
      query: jest
        .fn()
        .mockResolvedValue([{ payment_id: '61', ack: 'confirmed' }]),
    };
    self.identityClient = identity;
    self.logger = { warn: jest.fn() };
    // 2crjWf7v #4 — `courier_ack` manbasi; bu yo'lda chaqirilmasligi kerak
    // (`payment_ack` withPaymentAcks dan keladi).
    const courierAcks = { flags: jest.fn().mockResolvedValue(new Map()) };
    self.courierAcks = courierAcks;
    return {
      service: self as unknown as FinanceServiceService,
      identity,
      courierAcks,
    };
  };

  type Row = Record<string, any>;
  type Result = {
    statusCode: number;
    data: {
      cashbox: Row;
      cashboxHistory: Row[];
      income: number;
      outcome: number;
    };
  };
  const askedIds = (identity: { send: jest.Mock }) =>
    (identity.send.mock.calls as Array<[{ cmd: string }, { id: string }]>)
      .map(([pattern, payload]) => {
        expect(pattern).toEqual({ cmd: 'identity.user.find_by_id' });
        return String(payload.id);
      })
      .sort();

  it('⭐ menejer filial kassasi: «Kuryerdan filialga o`tkazma» qatorida kuryer ismi (source_user); kassa egasi null (CODE-08)', async () => {
    const { service, identity } = make(
      { id: '20', user_id: '15', cashbox_type: Cashbox_type.BRANCH },
      [
        {
          id: '61',
          cashbox_id: '20',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.INCOME,
          source_user_id: '26',
          created_by: '25',
          amount: 300_000,
        },
        {
          id: '62',
          cashbox_id: '20',
          source_type: Source_type.BRANCH_TO_MAIN,
          operation_type: Operation_type.EXPENSE,
          // Kontragent odam emas (filial) — source_user hal qilinmaydi.
          source_user_id: '15',
          created_by: '1',
          amount: 100_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '15',
      cashbox_type: Cashbox_type.BRANCH,
    })) as unknown as Result;

    expect(res.statusCode).toBe(200);
    const [courierRow, branchRow] = res.data.cashboxHistory;
    expect(courierRow).toMatchObject({
      id: '61',
      source_user: { id: '26', name: 'Kuryer Ali' },
      sourceUser: { id: '26', name: 'Kuryer Ali' },
      created_by_user: { id: '25', name: 'Menejer Urgut' },
    });
    expect(branchRow).toMatchObject({
      id: '62',
      source_user: null,
      created_by_user: { id: '1', name: 'Superadmin' },
    });
    // BRANCH kassasi egasi — filial, odam emas.
    expect(res.data.cashbox).toMatchObject({ id: '20', user: null });
    // '15' (filial id si) identity'dan foydalanuvchi sifatida SO'RALMAYDI.
    expect(askedIds(identity)).toEqual(['1', '25', '26']);
    // Filial kassasida kvitansiya so'rovi yo'q (faqat kuryer kassasi).
    expect('payment_ack' in courierRow).toBe(false);
    expect(res.data).toMatchObject({ income: 300_000, outcome: 100_000 });
  });

  it('kuryer kassasi: cashbox.user — kuryer; payment_ack saqlanadi; courier_ack qo`shilmaydi', async () => {
    const { service, courierAcks } = make(
      { id: '21', user_id: '26', cashbox_type: Cashbox_type.FOR_COURIER },
      [
        {
          id: '61',
          cashbox_id: '21',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.EXPENSE,
          source_user_id: '26',
          created_by: '25',
          amount: 300_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '26',
      cashbox_type: Cashbox_type.FOR_COURIER,
    })) as unknown as Result;

    expect(res.data.cashbox).toMatchObject({
      id: '21',
      user: { id: '26', name: 'Kuryer Ali' },
    });
    expect(res.data.cashboxHistory[0]).toMatchObject({
      payment_ack: 'confirmed',
      source_user: { id: '26' },
      created_by_user: { id: '25' },
    });
    expect('courier_ack' in res.data.cashboxHistory[0]).toBe(false);
    expect(courierAcks.flags).not.toHaveBeenCalled();
  });

  it('market kassasi: MARKET_PAYMENT qatorida source_user — market; cashbox.user — market', async () => {
    const { service } = make(
      { id: '16', user_id: '37', cashbox_type: Cashbox_type.FOR_MARKET },
      [
        {
          id: '90',
          cashbox_id: '16',
          source_type: Source_type.MARKET_PAYMENT,
          operation_type: Operation_type.EXPENSE,
          source_user_id: '37',
          created_by: '1',
          amount: 1_950_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '37',
      cashbox_type: Cashbox_type.FOR_MARKET,
    })) as unknown as Result;

    expect(res.data.cashbox.user).toMatchObject({
      id: '37',
      name: 'TEST market',
    });
    expect(res.data.cashboxHistory[0]).toMatchObject({
      source_user: { id: '37', name: 'TEST market' },
      created_by_user: { id: '1' },
    });
  });

  it('MAIN kassa — egasi null, identity faqat xodim uchun', async () => {
    const { service, identity } = make(
      { id: '1', user_id: '0', cashbox_type: Cashbox_type.MAIN },
      [
        {
          id: '70',
          cashbox_id: '1',
          source_type: Source_type.MANUAL_INCOME,
          operation_type: Operation_type.INCOME,
          created_by: '1',
          amount: 5_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '0',
      cashbox_type: Cashbox_type.MAIN,
    })) as unknown as Result;

    expect(res.data.cashbox.user).toBeNull();
    expect(askedIds(identity)).toEqual(['1']);
  });

  it('identity javob bermasa — ismlar null, tarix va summalar baribir qaytadi', async () => {
    const { service } = make(
      { id: '20', user_id: '15', cashbox_type: Cashbox_type.BRANCH },
      [
        {
          id: '61',
          cashbox_id: '20',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.INCOME,
          source_user_id: '26',
          created_by: '25',
          amount: 300_000,
        },
      ],
      jest.fn(() => throwError(() => new Error('identity down'))),
    );

    const res = (await service.getCashboxByUserId({
      id: '15',
      cashbox_type: Cashbox_type.BRANCH,
    })) as unknown as Result;

    expect(res.statusCode).toBe(200);
    expect(res.data.cashboxHistory).toHaveLength(1);
    expect(res.data.cashboxHistory[0]).toMatchObject({
      id: '61',
      source_user: null,
      created_by_user: null,
    });
    expect(res.data.income).toBe(300_000);
  }, 15_000);
});
