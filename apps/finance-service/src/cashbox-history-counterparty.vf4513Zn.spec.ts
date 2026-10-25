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

/**
 * vf4513Zn (prod tester, 2026-10-25): `source_user` / `created_by_user` /
 * `cashbox.user` identity'ning TO'LIQ yozuvi edi — kuryer 26 o'z kassasida
 * («sotuvda marketga to'g'ridan-to'g'ri berildi» qatori) market 37 ning
 * `tariff_home`/`tariff_center`, `salary`, `commission_*`, `ai_price_per_order`
 * ini ko'rardi. Endi har qanday rol yo'lida faqat `{id, name, role,
 * phone_number}`.
 */
describe('vf4513Zn — tarixdagi foydalanuvchi obyektlari minimal (moliya sizmaydi)', () => {
  /** identity `find_by_id` qaytaradigan realistik TO'LIQ yozuvlar. */
  const fullUsers: Record<string, Record<string, unknown>> = {
    '25': {
      id: '25',
      name: 'TEST Claude Menejer',
      phone_number: '+998900000025',
      role: 'manager',
      status: 'active',
      salary: 7_000_000,
      payment_day: 5,
      username: 'menejer25',
      telegram_id: '111',
      region_id: '3',
      region: { id: '3', name: 'Andijon' },
    },
    '26': {
      id: '26',
      name: 'TEST Claude Kuryer',
      phone_number: '+998900000026',
      role: 'courier',
      status: 'active',
      tariff_home: 15_000,
      tariff_center: 12_000,
      salary: 3_000_000,
      payment_day: 10,
      compensation_mode: 'tariff',
      is_super_courier: false,
      telegram_id: '222',
    },
    '37': {
      id: '37',
      name: 'TEST Claude Market',
      phone_number: '+998900000037',
      role: 'market',
      status: 'active',
      tariff_home: 20_000,
      tariff_center: 20_000,
      default_tariff: 'center',
      compensation_mode: 'tariff',
      salary: 0,
      payment_day: 1,
      commission_type: 'percent',
      commission_value: 5,
      ai_price_per_order: 300,
      extra_number: '+998900000099',
      address: 'Andijon',
      market_tg_token: null,
    },
  };

  const ALLOWED = ['id', 'name', 'phone_number', 'role'];
  const MONEY =
    /tariff|salary|commission|payment_day|compensation|price|token/i;
  const USER_KEYS = [
    'source_user',
    'sourceUser',
    'created_by_user',
    'createdByUser',
    'user',
  ];

  /** Javob daraxtidagi barcha foydalanuvchi obyektlari (`USER_KEYS` ostida). */
  const nestedUsers = (
    value: unknown,
    out: Array<Record<string, unknown>> = [],
  ) => {
    if (Array.isArray(value)) {
      value.forEach((item) => nestedUsers(item, out));
    } else if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (USER_KEYS.includes(key) && nested && typeof nested === 'object') {
          out.push(nested as Record<string, unknown>);
        }
        nestedUsers(nested, out);
      }
    }
    return out;
  };

  const expectMinimal = (payload: unknown, expectedCount: number) => {
    const found = nestedUsers(payload);
    expect(found).toHaveLength(expectedCount);
    for (const user of found) {
      expect(Object.keys(user).sort()).toEqual(ALLOWED);
      expect(Object.keys(user).filter((key) => MONEY.test(key))).toEqual([]);
    }
  };

  const make = (
    cashbox: Record<string, unknown>,
    history: Array<Record<string, unknown>>,
  ) => {
    const self = Object.create(FinanceServiceService.prototype) as Record<
      string,
      unknown
    >;
    self.cashboxRepo = { findOne: jest.fn().mockResolvedValue(cashbox) };
    self.historyRepo = {
      find: jest.fn().mockResolvedValue(history),
      findOne: jest.fn().mockResolvedValue(history[0]),
      query: jest.fn().mockResolvedValue([]),
    };
    self.identityClient = {
      send: jest.fn((_pattern: unknown, payload: { id: string }) =>
        of({ statusCode: 200, data: fullUsers[String(payload.id)] ?? null }),
      ),
    };
    self.logger = { warn: jest.fn() };
    self.courierAcks = { flags: jest.fn().mockResolvedValue(new Map()) };
    return self as unknown as FinanceServiceService;
  };

  it('⭐ kuryer 26 my-cashbox: «marketga to`g`ridan-to`g`ri berildi» qatorida source_user — market 37 ning faqat {id, name, role, phone_number}', async () => {
    const service = make(
      { id: '21', user_id: '26', cashbox_type: Cashbox_type.FOR_COURIER },
      [
        {
          id: '110',
          cashbox_id: '21',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.EXPENSE,
          source_user_id: '37',
          created_by: '25',
          comment: "Buyurtma #69: sotuvda marketga to'g'ridan-to'g'ri berildi",
          amount: 30_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '26',
      cashbox_type: Cashbox_type.FOR_COURIER,
    })) as unknown as { data: Record<string, any> };

    const [row] = res.data.cashboxHistory;
    expect(row.source_user).toEqual({
      id: '37',
      name: 'TEST Claude Market',
      role: 'market',
      phone_number: '+998900000037',
    });
    expect(row.sourceUser).toEqual(row.source_user);
    expect(row.created_by_user).toEqual({
      id: '25',
      name: 'TEST Claude Menejer',
      role: 'manager',
      phone_number: '+998900000025',
    });
    expect(res.data.cashbox.user).toEqual({
      id: '26',
      name: 'TEST Claude Kuryer',
      role: 'courier',
      phone_number: '+998900000026',
    });
    // source_user, sourceUser, created_by_user, createdByUser, cashbox.user.
    expectMinimal(res.data, 5);
  });

  it('market 37 my-cashbox: kuryer 26 (created_by_user) tarifi/maoshi chiqmaydi', async () => {
    const service = make(
      { id: '16', user_id: '37', cashbox_type: Cashbox_type.FOR_MARKET },
      [
        {
          id: '111',
          cashbox_id: '16',
          source_type: Source_type.MARKET_PAYMENT,
          operation_type: Operation_type.INCOME,
          source_user_id: '37',
          created_by: '26',
          amount: 30_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '37',
      cashbox_type: Cashbox_type.FOR_MARKET,
    })) as unknown as { data: Record<string, any> };

    expect(res.data.cashboxHistory[0].created_by_user).toEqual({
      id: '26',
      name: 'TEST Claude Kuryer',
      role: 'courier',
      phone_number: '+998900000026',
    });
    expectMinimal(res.data, 5);
  });

  it('menejer filial kassasi: kuryer kontragenti va xodim — minimal; filial egasi null', async () => {
    const service = make(
      { id: '20', user_id: '3', cashbox_type: Cashbox_type.BRANCH },
      [
        {
          id: '112',
          cashbox_id: '20',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.INCOME,
          source_user_id: '26',
          created_by: '25',
          amount: 300_000,
        },
      ],
    );

    const res = (await service.getCashboxByUserId({
      id: '3',
      cashbox_type: Cashbox_type.BRANCH,
    })) as unknown as { data: Record<string, any> };

    expect(res.data.cashbox.user).toBeNull();
    expect(res.data.cashboxHistory[0].source_user).toMatchObject({
      id: '26',
      name: 'TEST Claude Kuryer',
    });
    // cashbox.user = null — hisoblanmaydi.
    expectMinimal(res.data, 4);
  });

  it('GET /finance/history/:id (tafsilot) ham minimal', async () => {
    const service = make(
      { id: '21', user_id: '26', cashbox_type: Cashbox_type.FOR_COURIER },
      [
        {
          id: '110',
          cashbox_id: '21',
          source_type: Source_type.COURIER_PAYMENT,
          operation_type: Operation_type.EXPENSE,
          source_user_id: '37',
          created_by: '25',
          amount: 30_000,
          cashbox: {
            id: '21',
            user_id: '26',
            cashbox_type: Cashbox_type.FOR_COURIER,
          },
        },
      ],
    );

    const res = (await service.findHistoryById('110')) as unknown as {
      data: Record<string, any>;
    };

    expect(res.data.source_user).toMatchObject({ id: '37' });
    expect(res.data.cashbox.user).toMatchObject({ id: '26' });
    expectMinimal(res.data, 5);
  });
});
