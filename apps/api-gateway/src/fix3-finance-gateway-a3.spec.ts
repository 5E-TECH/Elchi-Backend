import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isObservable, of, throwError, TimeoutError } from 'rxjs';

jest.mock('@app/common', () => ({
  Cashbox_type: {
    BRANCH: 'branch',
    FOR_COURIER: 'couriers',
    FOR_MARKET: 'markets',
    MAIN: 'main',
  },
  FinancialSource_type: { MANUAL_EXPENSE: 'manual_expense' },
  Operation_type: { EXPENSE: 'expense', INCOME: 'income' },
  Order_status: { PAID: 'paid', PARTLY_PAID: 'partly_paid', SOLD: 'sold' },
  PaymentMethod: {
    CASH: 'cash',
    CLICK: 'click',
    CLICK_TO_MARKET: 'click_to_market',
  },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    REGISTRATOR: 'registrator',
    COURIER: 'courier',
    MARKET: 'market',
    MANAGER: 'manager',
  },
  Source_type: {
    BRANCH_TO_MAIN: 'branch_to_main',
    COURIER_PAYMENT: 'courier_payment',
    MARKET_PAYMENT: 'market_payment',
  },
  Where_deliver: { CENTER: 'center' },
}));

import { FinanceGatewayController } from './finance-gateway.controller';
import { FindCashboxByUserQueryDto } from './dto/finance.swagger.dto';

/**
 * FIX3 / A3 — finance-gateway tuzatishlari: C1 (idempotentlik barmoq izi),
 * C2 (kassa sahifasi sana filtri), C3 (menejer kuryer naqdi — faqat o'z
 * filiali), M4 (menejer "Marketga o'tkazma" qila olmaydi), M16, BE-PAY-14,
 * CODE-08 (registrator tarixi).
 *
 * Mock'lar `cmd` bo'yicha javob beradi; ro'yxatda yo'q `cmd` kelsa xato —
 * kutilmagan RPC chaqiruvi ham test xatosi.
 */

type Handler = (payload: any) => unknown;
type Client = { send: jest.Mock };

function route(client: Client, handlers: Record<string, Handler>) {
  client.send.mockImplementation((pattern: { cmd: string }, payload: any) => {
    const handler = handlers[pattern.cmd];
    if (!handler) {
      return throwError(
        () =>
          new Error(
            `kutilmagan RPC: ${pattern.cmd} ${JSON.stringify(payload)}`,
          ),
      );
    }
    const result = handler(payload);
    return isObservable(result) ? result : of(result);
  });
}

const cmdsOf = (client: Client) =>
  client.send.mock.calls.map((call: any[]) => call[0]?.cmd);
const payloadsOf = (client: Client, cmd: string) =>
  client.send.mock.calls
    .filter((call: any[]) => call[0]?.cmd === cmd)
    .map((call: any[]) => call[1]);
const payloadOf = (client: Client, cmd: string) => payloadsOf(client, cmd)[0];

function setup() {
  const financeClient: Client = { send: jest.fn() };
  const identityClient: Client = { send: jest.fn() };
  const branchClient: Client = { send: jest.fn() };
  const orderClient: Client = { send: jest.fn() };
  const controller = new FinanceGatewayController(
    financeClient as any,
    identityClient as any,
    branchClient as any,
    orderClient as any,
  );
  return {
    controller,
    financeClient,
    identityClient,
    branchClient,
    orderClient,
  };
}

const superadmin = { user: { sub: '9', roles: ['superadmin'] } } as any;
const manager15 = {
  user: { sub: '208', roles: ['manager'], branch_id: '15' },
} as any;

const courierUser = (id: string) => ({
  id,
  name: 'Ali Valiyev',
  phone_number: '+998901112233',
  role: 'courier',
  status: 'active',
});

describe('C1 / M2 — market va filial→HQ to`lovi: zaxira token payment_date ga bog`liq emas', () => {
  // 30 s dedup oynasi chegarasiga tushib qolmaslik uchun soat qotiriladi.
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_790_000_005_000);
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('market: kalitsiz ikki bosish (yangi payment_date/comment) → BIR XIL token', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.payment_market': () => ({ statusCode: 200, data: {} }),
    });
    const base = {
      market_id: '201',
      amount: 2_000_000,
      payment_method: 'cash',
    };

    await env.controller.paymentToMarket(superadmin, {
      ...base,
      payment_date: '2026-10-01T06:00:00.000Z',
      comment: 'birinchi',
    } as any);
    await env.controller.paymentToMarket(superadmin, {
      ...base,
      payment_date: '2026-10-01T06:00:09.000Z',
      comment: 'ikkinchi',
    } as any);

    const [first, second] = payloadsOf(
      env.financeClient,
      'finance.cashbox.payment_market',
    );
    expect(first.dedup_epoch).toBeTruthy();
    expect(second.dedup_epoch).toBe(first.dedup_epoch);
    // payment_date tarixga baribir yoziladi.
    expect(second.payment_date).toBe('2026-10-01T06:00:09.000Z');
  });

  it('market: summa yoki market farq qilsa — boshqa token', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.payment_market': () => ({ statusCode: 200, data: {} }),
    });

    await env.controller.paymentToMarket(superadmin, {
      market_id: '201',
      amount: 1000,
      payment_method: 'cash',
    } as any);
    await env.controller.paymentToMarket(superadmin, {
      market_id: '201',
      amount: 2000,
      payment_method: 'cash',
    } as any);
    await env.controller.paymentToMarket(superadmin, {
      market_id: '305',
      amount: 1000,
      payment_method: 'cash',
    } as any);

    const tokens = payloadsOf(
      env.financeClient,
      'finance.cashbox.payment_market',
    ).map((payload) => payload.dedup_epoch);
    expect(new Set(tokens).size).toBe(3);
  });

  it('market: Idempotency-Key kelsa aynan o`sha kalit dedup token bo`ladi', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.payment_market': () => ({
        statusCode: 200,
        data: { idempotent: true },
      }),
    });

    const res: any = await env.controller.paymentToMarket(
      superadmin,
      { market_id: '201', amount: 1000, payment_method: 'cash' } as any,
      'fe-key-123',
    );

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.payment_market')
        .dedup_epoch,
    ).toBe('fe-key-123');
    // Takroriy javob o'zgarishsiz uzatiladi (courier to'lovi bilan bir xil).
    expect(res).toEqual({ statusCode: 200, data: { idempotent: true } });
  });

  it('filial→HQ: kalitsiz ikki bosish (yangi payment_date) → BIR XIL token; kalit bo`lsa — kalit', async () => {
    const env = setup();
    route(env.branchClient, {
      'branch.find_by_id': () => ({ data: { id: '15' } }),
    });
    route(env.financeClient, {
      'finance.cashbox.payment_branch_main': () => ({ statusCode: 200 }),
    });
    const base = { branch_id: '15', amount: 300_000, payment_method: 'cash' };

    await env.controller.paymentBranchToMain(manager15, {
      ...base,
      payment_date: '2026-10-01T06:00:00.000Z',
    } as any);
    await env.controller.paymentBranchToMain(manager15, {
      ...base,
      payment_date: '2026-10-01T06:00:07.000Z',
    } as any);
    await env.controller.paymentBranchToMain(
      manager15,
      { ...base, payment_date: '2026-10-01T06:00:08.000Z' } as any,
      'fe-branch-key',
    );

    const tokens = payloadsOf(
      env.financeClient,
      'finance.cashbox.payment_branch_main',
    ).map((payload) => payload.dedup_epoch);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).toBe('fe-branch-key');
  });
});

describe('M4 — menejer "Marketga o`tkazma" qila olmaydi', () => {
  it('click_to_market → 403, hech qanday RPC chaqirilmaydi', async () => {
    const env = setup();

    await expect(
      env.controller.paymentFromCourier(manager15, {
        courier_id: '209',
        amount: 300_000,
        payment_method: 'click_to_market',
        market_id: '201',
      } as any),
    ).rejects.toMatchObject({
      status: 403,
      message:
        "Marketga o'tkazma (click_to_market) faqat HQ kassasi orqali (superadmin/admin) qabul qilinadi",
    });
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.branchClient.send).not.toHaveBeenCalled();
    expect(env.identityClient.send).not.toHaveBeenCalled();
  });
});

describe('C3 / M7 / RBAC-07 — menejer faqat O`Z filiali kuryeridan naqd oladi', () => {
  /**
   * Eski branch-service resolver'i HQ (ajdod) ni ham "ruxsat" deb qaytaradi —
   * gateway'ning qat'iy tekshiruvi baribir to'xtatishi shart.
   */
  function managerEnv(
    over: { findByBranch?: Handler; resolvedBranch?: string | null } = {},
  ) {
    const env = setup();
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({ data: courierUser(String(p.id)) }),
    });
    route(env.branchClient, {
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: over.resolvedBranch ?? null },
      }),
      'branch.user.find_by_user': () => ({ data: { branch_id: '15' } }),
      'branch.user.find_by_branch':
        over.findByBranch ??
        (() => ({
          data: [
            { user_id: '208', branch_id: '15', role: 'MANAGER' },
            { user_id: '209', branch_id: '15', role: 'COURIER' },
          ],
        })),
    });
    route(env.financeClient, {
      'finance.cashbox.payment_courier': () => ({ statusCode: 201 }),
    });
    return env;
  }

  const dto = (courierId: string) =>
    ({
      courier_id: courierId,
      amount: 250_000,
      payment_method: 'cash',
    }) as any;

  it('HQ kuryeri (179) — resolver ajdod HQ ni qaytarsa ham → 403, pul ko`chmaydi', async () => {
    const env = managerEnv({ resolvedBranch: '1' });

    await expect(
      env.controller.paymentFromCourier(manager15, dto('179')),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Bu kuryer sizning filialingizga tegishli emas',
    });
    expect(cmdsOf(env.financeClient)).not.toContain(
      'finance.cashbox.payment_courier',
    );
    expect(payloadOf(env.branchClient, 'branch.user.find_by_branch')).toEqual(
      expect.objectContaining({
        branch_id: '15',
        requester: expect.objectContaining({ id: '208' }),
      }),
    );
  });

  it('o`z filiali kuryeri (209) → qabul qilinadi, qabul qiluvchi — filial 15', async () => {
    const env = managerEnv({ resolvedBranch: '15' });

    await env.controller.paymentFromCourier(manager15, dto('209'), 'idem-9');

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.payment_courier'),
    ).toEqual(
      expect.objectContaining({
        courier_id: '209',
        receiver_user_id: '15',
        receiver_cashbox_type: 'branch',
        dedup_epoch: 'idem-9',
      }),
    );
  });

  it('o`chirilgan (isDeleted) qator hisobga olinmaydi → 403', async () => {
    const env = managerEnv({
      resolvedBranch: '15',
      findByBranch: () => ({
        data: [{ user_id: '209', branch_id: '15', isDeleted: true }],
      }),
    });

    await expect(
      env.controller.paymentFromCourier(manager15, dto('209')),
    ).rejects.toMatchObject({ status: 403 });
    expect(cmdsOf(env.financeClient)).not.toContain(
      'finance.cashbox.payment_courier',
    );
  });

  it('filial xizmati javob bermasa (timeout) → 503, pul ko`chmaydi', async () => {
    const env = managerEnv({
      resolvedBranch: '15',
      findByBranch: () => throwError(() => new TimeoutError()),
    });

    await expect(
      env.controller.paymentFromCourier(manager15, dto('209')),
    ).rejects.toMatchObject({
      status: 503,
      message: "Tekshiruv xizmati javob bermadi, keyinroq urinib ko'ring",
    });
    expect(cmdsOf(env.financeClient)).not.toContain(
      'finance.cashbox.payment_courier',
    );
  });

  it('filial xizmati 403 qaytarsa → 403 (kuryer bu filialda emas)', async () => {
    const env = managerEnv({
      resolvedBranch: '15',
      findByBranch: () =>
        throwError(() => ({ statusCode: 403, message: 'ruxsat yo`q' })),
    });

    await expect(
      env.controller.paymentFromCourier(manager15, dto('209')),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Bu kuryer sizning filialingizga tegishli emas',
    });
  });

  it('resolver ajdod (HQ) ni qaytarsa ham GET cashbox/user/<HQ kuryeri> → 403, kassa ko`rsatilmaydi', async () => {
    const env = setup();
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({ data: courierUser(String(p.id)) }),
    });
    route(env.branchClient, {
      // Eski resolver: HQ kuryeri 179 → uning filiali HQ (menejerning ajdodi).
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: '1' },
      }),
      // Menejer boshqa foydalanuvchining qatorini o'qiy olmaydi (branch-service).
      'branch.user.find_by_user': () =>
        throwError(() => ({ statusCode: 403, message: 'ruxsat yo`q' })),
      'branch.user.find_by_branch': () => ({
        data: [{ user_id: '209', branch_id: '15', role: 'COURIER' }],
      }),
    });
    route(env.financeClient, {});

    await expect(
      env.controller.findCashboxByUser(
        '179',
        { cashbox_type: 'couriers', with_history: true } as any,
        manager15,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      env.controller.cashboxByUserId('179', {} as any, manager15),
    ).rejects.toMatchObject({ status: 403 });
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it('gateway endi ota filialga (ajdodga) o`zi kirish bermaydi: GET cashbox/user/<HQ id> → 403', async () => {
    const env = setup();
    route(env.branchClient, {
      // branch-service (A6) endi ajdodni qaytarmaydi.
      'branch.cashbox.resolve_for_manager': () => ({ data: null }),
      'branch.user.find_by_user': () => ({ data: null }),
      'branch.user.find_by_branch': () => ({ data: [] }),
    });
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({
        data: { id: String(p.id), role: 'superadmin' },
      }),
    });
    route(env.financeClient, {});

    await expect(
      env.controller.findCashboxByUser(
        '1',
        { with_history: true } as any,
        manager15,
      ),
    ).rejects.toMatchObject({ status: 403 });
    // Ilgari gateway `branch.find_by_id` bilan ota filialni o'zi ochardi.
    expect(cmdsOf(env.branchClient)).not.toContain('branch.find_by_id');
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });
});

describe('BE-PAY-14 — menejerning kuryer sahifasi kuryer kassasini ko`rsatadi', () => {
  it('cashbox_type=couriers + filialdagi kuryer → FOR_COURIER (filial kassasi EMAS) + user', async () => {
    const env = setup();
    route(env.branchClient, {
      // Resolver filialdagi kuryer uchun filial id sini qaytaradi.
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: '15' },
      }),
    });
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({ data: courierUser(String(p.id)) }),
    });
    route(env.financeClient, {
      'finance.cashbox.find_by_user': (p) => ({
        data: {
          cashbox: {
            id: `cb-${p.user_id}`,
            user_id: String(p.user_id),
            cashbox_type: p.cashbox_type,
            balance: 250_000,
          },
          history: [],
        },
      }),
    });

    const response: any = await env.controller.findCashboxByUser(
      '209',
      {
        cashbox_type: 'couriers',
        with_history: true,
        page: 1,
        limit: 100,
      } as any,
      manager15,
    );

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.find_by_user'),
    ).toEqual(
      expect.objectContaining({ user_id: '209', cashbox_type: 'couriers' }),
    );
    expect(response.data.cashbox.cashbox_type).toBe('couriers');
    expect(response.data.user).toEqual(
      expect.objectContaining({ id: '209', name: 'Ali Valiyev' }),
    );
  });

  it('turi berilmasa (menejerning o`z id si) — avvalgidek filial kassasi', async () => {
    const env = setup();
    route(env.branchClient, {
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: '15' },
      }),
    });
    route(env.financeClient, {
      'finance.cashbox.find_by_user': () => ({
        data: { cashbox: { id: 'b15', cashbox_type: 'branch' }, history: [] },
      }),
    });

    await env.controller.findCashboxByUser(
      '208',
      { with_history: true } as any,
      manager15,
    );

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.find_by_user'),
    ).toEqual(
      expect.objectContaining({ user_id: '15', cashbox_type: 'branch' }),
    );
  });
});

describe('C2 / FE-PAY-04 — kassa sahifasi sana filtri', () => {
  async function validateQuery(plain: Record<string, unknown>) {
    const instance = plainToInstance(FindCashboxByUserQueryDto, plain);
    return validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('DTO fromDate/toDate ni qabul qiladi (forbidNonWhitelisted → 400 EMAS)', async () => {
    const errors = await validateQuery({
      cashbox_type: 'markets',
      with_history: 'true',
      page: '1',
      limit: '100',
      fromDate: '2026-10-01',
      toDate: '2026-10-01',
    });

    expect(errors).toEqual([]);
  });

  it('noma`lum parametr avvalgidek rad etiladi', async () => {
    const errors = await validateQuery({ fromDate: '2026-10-01', foo: '1' });

    expect(errors.map((error) => error.property)).toEqual(['foo']);
  });

  it('fromDate/toDate finance.cashbox.find_by_user ga uzatiladi', async () => {
    const env = setup();
    route(env.branchClient, {
      'branch.find_by_id': () => throwError(() => new Error('branch emas')),
    });
    route(env.identityClient, {
      'identity.user.find_by_id': () => ({
        data: { id: '201', role: 'market' },
      }),
    });
    route(env.financeClient, {
      'finance.cashbox.find_by_user': () => ({
        data: { cashbox: { id: 'mk', cashbox_type: 'markets' }, history: [] },
      }),
    });

    await env.controller.findCashboxByUser(
      '201',
      {
        cashbox_type: 'markets',
        with_history: true,
        fromDate: '2026-10-01',
        toDate: '2026-10-02',
      } as any,
      superadmin,
    );

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.find_by_user'),
    ).toEqual(
      expect.objectContaining({
        user_id: '201',
        cashbox_type: 'markets',
        fromDate: '2026-10-01',
        toDate: '2026-10-02',
      }),
    );
  });

  it('kassalar ro`yxati yo`lida tarix ham sana bilan so`raladi (from_date/to_date)', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.find_by_user': () => ({ data: [{ id: 'c7' }] }),
      'finance.history.find_all': () => ({ data: { items: [] } }),
    });
    const courier = { user: { sub: '7', roles: ['courier'] } } as any;

    await env.controller.findCashboxByUser(
      '7',
      {
        with_history: true,
        fromDate: '2026-10-01',
        toDate: '2026-10-01',
      } as any,
      courier,
    );

    expect(payloadOf(env.financeClient, 'finance.history.find_all')).toEqual(
      expect.objectContaining({
        cashbox_id: 'c7',
        from_date: '2026-10-01',
        to_date: '2026-10-01',
      }),
    );
  });
});

describe('M16 — SA "Berilishi kerak" kartasi', () => {
  function allInfoEnv(financeData: Record<string, unknown>) {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.all_info': () => ({
        statusCode: 200,
        data: { ...financeData },
      }),
    });
    route(env.branchClient, {
      'branch.find_all': () => ({ data: { items: [] } }),
    });
    return env;
  }

  it('faqat musbat market kassalari yig`indisi (marketPayableTotal)', async () => {
    const env = allInfoEnv({
      mainCashboxTotal: 5_000_000,
      marketCashboxTotal: 800_000,
      marketPayableTotal: 1_000_000,
    });

    const res: any = await env.controller.allCashboxesInfo(
      {} as any,
      superadmin,
    );

    expect(res.data.berilishi_kerak).toBe(1_000_000);
    // Imzoli yig'indi o'zgarishsiz qoladi.
    expect(res.data.marketCashboxTotal).toBe(800_000);
  });

  it('eski finance javobi (maydon yo`q) — avvalgi qiymat', async () => {
    const env = allInfoEnv({
      mainCashboxTotal: 0,
      marketCashboxTotal: 800_000,
    });

    const res: any = await env.controller.allCashboxesInfo(
      {} as any,
      superadmin,
    );

    expect(res.data.berilishi_kerak).toBe(800_000);
  });
});

describe('CODE-08 — registrator kassa tarixi faqat o`z filiali', () => {
  const registrator = {
    user: { sub: '269', roles: ['registrator'], branch_id: '1' },
  } as any;

  it('GET /finance/history: MAIN/boshqa kassa so`ralsa ham — o`z filiali kassasi', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.history.find_all': () => ({ data: { items: [] } }),
    });

    await env.controller.findHistory(
      { cashbox_type: 'main', user_id: '0' } as any,
      registrator,
    );

    expect(payloadOf(env.financeClient, 'finance.history.find_all')).toEqual(
      expect.objectContaining({ user_id: '1', cashbox_type: 'branch' }),
    );
  });

  it('filiali aniqlanmasa → 403', async () => {
    const env = setup();
    route(env.branchClient, {
      'branch.user.find_by_user': () => ({ data: null }),
    });

    await expect(
      env.controller.findHistory(
        {} as any,
        {
          user: { sub: '269', roles: ['registrator'] },
        } as any,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it('GET /finance/history/:id: o`z filiali — ok; MAIN yozuvi — 403', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.history.find_by_id': (p) => ({
        data:
          p.id === '10'
            ? { id: '10', cashbox: { user_id: '1', cashbox_type: 'branch' } }
            : { id: '11', cashbox: { user_id: '0', cashbox_type: 'main' } },
      }),
    });

    await expect(
      env.controller.findHistoryById('10', registrator),
    ).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ id: '10' }) }),
    );
    await expect(
      env.controller.findHistoryById('11', registrator),
    ).rejects.toMatchObject({
      status: 403,
      message: "Siz faqat o'z filialingiz kassa tarixini ko'ra olasiz",
    });
  });

  it('kutilmagan rol → 403 (yopiq)', async () => {
    const env = setup();
    route(env.financeClient, {
      'finance.history.find_by_id': () => ({
        data: { id: '12', cashbox: { user_id: '0', cashbox_type: 'main' } },
      }),
    });

    await expect(
      env.controller.findHistoryById('12', {
        user: { sub: '5', roles: ['investor'] },
      } as any),
    ).rejects.toMatchObject({
      status: 403,
      message: "Siz bu kassa tarixini ko'ra olmaysiz",
    });
  });
});
