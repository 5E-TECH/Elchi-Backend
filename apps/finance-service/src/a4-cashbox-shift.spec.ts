import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';
import { Shift } from './entities/shift.entity';
import { Cashbox } from './entities/cashbox.entity';

/**
 * 4-tur, A guruhi — kassa / smena (2026-10-14):
 *  - i75GDixP — filial kassasi qo'lda chiqimda manfiyga tushmaydi (aniq
 *    `allow_negative` bayrog'i);
 *  - QTCUUgjA — smena darvozasi (`requireOpenShift`) va yopishda kamomad;
 *  - kfdfYDik — smenani `{comment}` bilan yopish / joriy smena;
 *  - 3PE0B03q — "O'tkazma manbasi" (`transfer_source_user_id`).
 */

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
  ...jest.requireActual('@app/common/activity-log/describe-uz'),
  Cashbox_type: {
    MAIN: 'main',
    FOR_COURIER: 'couriers',
    FOR_MARKET: 'markets',
    BRANCH: 'branch',
  },
  Operation_type: { INCOME: 'income', EXPENSE: 'expense' },
  Source_type: {
    COURIER_PAYMENT: 'courier_payment',
    BRANCH_TO_MAIN: 'branch_to_main',
    MARKET_PAYMENT: 'market_payment',
    MANUAL_EXPENSE: 'manual_expense',
    MANUAL_INCOME: 'manual_income',
    CORRECTION: 'correction',
    SALARY: 'salary',
    SELL: 'sell',
    CANCEL: 'cancel',
    EXTRA_COST: 'extra_cost',
    BILLS: 'bills',
  },
  FinancialSource_type: { SELL_PROFIT: 'sell_profit' },
  Order_status: {
    SOLD: 'sold',
    PAID: 'paid',
    PARTLY_PAID: 'partly_paid',
    WAITING: 'waiting',
  },
  PaymentMethod: {
    CASH: 'cash',
    CLICK: 'click',
    CLICK_TO_MARKET: 'click_to_market',
  },
  Commission_type: { PERCENT: 'percent', FIXED: 'fixed' },
  ActivityAction: {
    CREATED: 'created',
    DELETED: 'deleted',
    UPDATED: 'updated',
    PAYMENT: 'payment',
    STATUS_CHANGE: 'status_change',
  },
  ActivityLogService: class {},
  rmqSend: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./entities/cashbox.entity', () => ({ Cashbox: class Cashbox {} }));
jest.mock('./entities/cashbox-history.entity', () => ({
  CashboxHistory: class CashboxHistory {},
}));
jest.mock('./entities/shift.entity', () => ({
  Shift: class Shift {},
  ShiftStatus: { OPEN: 'open', CLOSED: 'closed' },
}));
jest.mock('./entities/user-salary.entity', () => ({
  UserSalary: class UserSalary {},
}));
jest.mock('./entities/operator-earning.entity', () => ({
  OperatorEarning: class OperatorEarning {},
}));
jest.mock('./entities/operator-payment.entity', () => ({
  OperatorPayment: class OperatorPayment {},
}));
jest.mock('./entities/financial-balance-history.entity', () => ({
  FinancialBalanceHistory: class FinancialBalanceHistory {},
}));
// 3PE0B03q — nomli kartalar (servis importi; entity BaseEntity'ga bog'liq).
jest.mock('./entities/cashbox-card.entity', () => ({
  CashboxCard: class CashboxCard {},
}));
jest.mock('./entities/cashbox-card-movement.entity', () => ({
  CashboxCardMovement: class CashboxCardMovement {},
  CardMovementType: {
    CARD_TO_CARD: 'card_to_card',
    CARD_TO_CASH: 'card_to_cash',
    CASH_TO_CARD: 'cash_to_card',
  },
}));
// Elchi Pochta №1 — xarajat kategoriyalari (servis importi; entity BaseEntity'ga bog'liq).
jest.mock('./entities/cashbox-expense-category.entity', () => ({
  CashboxExpenseCategory: class CashboxExpenseCategory {},
}));

type Row = Record<string, any>;

/**
 * `manager.findOne` ni ENTITY va `where` bo'yicha yo'naltiradi — chaqiruvlar
 * tartibi (smena darvozasi qo'shilgani) testni sindirmasin.
 */
function makeEnv(opts: {
  cashboxes?: Row[];
  openShift?: Row | null;
  /** R6 — kassa (`cashbox_user_id`) bo'yicha ochiq smenalar. */
  openShifts?: Record<string, Row | null>;
  shiftById?: Row | null;
  totals?: Row[];
  shiftRepoFindOne?: jest.Mock;
}) {
  const cashboxes = opts.cashboxes ?? [];
  const findOne = jest.fn((entity: unknown, options: any) => {
    const where = options?.where ?? {};
    if (entity === Shift) {
      if (where.id) return Promise.resolve(opts.shiftById ?? null);
      if (opts.openShifts) {
        return Promise.resolve(
          opts.openShifts[String(where.cashbox_user_id)] ?? null,
        );
      }
      return Promise.resolve(opts.openShift ?? null);
    }
    if (entity === Cashbox) {
      const found = cashboxes.find(
        (c) =>
          (where.id == null || String(c.id) === String(where.id)) &&
          (where.user_id == null ||
            String(c.user_id) === String(where.user_id)) &&
          (where.cashbox_type == null || c.cashbox_type === where.cashbox_type),
      );
      return Promise.resolve(found ? { ...found } : null);
    }
    // CashboxHistory — idempotentlik tekshiruvi: oldingi yozuv yo'q.
    return Promise.resolve(null);
  });
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.totals ?? []),
  };
  const manager = {
    findOne,
    save: jest.fn((entity: any) => Promise.resolve({ id: 'saved', ...entity })),
    create: jest.fn((_entity: any, dto: any) => ({ ...dto })),
    createQueryBuilder: jest.fn(() => qb),
  };
  const queryRunner = {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource: any = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const shiftRepo: any = {
    findOne: opts.shiftRepoFindOne ?? jest.fn().mockResolvedValue(null),
  };
  const activityLog: any = { log: jest.fn().mockResolvedValue(undefined) };
  const orderClient: any = { send: jest.fn(() => of({ statusCode: 200 })) };
  const outbox: any = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new FinanceServiceService(
    {} as any,
    {} as any,
    shiftRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    dataSource,
    activityLog,
    orderClient,
    { send: jest.fn() } as any,
    { send: jest.fn() } as any,
    outbox,
  );
  jest
    .spyOn(service as any, 'scheduleMarketPaymentFollowUp')
    .mockResolvedValue(undefined);
  return { service, manager, queryRunner, qb, shiftRepo, activityLog };
}

const rpcErrorOf = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode: number;
    message: string;
  };
};

const savedCashbox = (manager: { save: jest.Mock }, id: string) =>
  manager.save.mock.calls
    .map((call) => call[0])
    .filter((row: Row) => row?.id === id)
    .pop();

const mainCashbox = (cash = 1_000_000, card = 0): Row => ({
  id: 'main-1',
  user_id: '0',
  cashbox_type: 'main',
  balance: cash + card,
  balance_cash: cash,
  balance_card: card,
});
const branchCashbox = (cash = 100_000, card = 0): Row => ({
  id: 'br-15',
  user_id: '15',
  cashbox_type: 'branch',
  balance: cash + card,
  balance_cash: cash,
  balance_card: card,
});
const courierCashbox = (): Row => ({
  id: 'cb-209',
  user_id: '209',
  cashbox_type: 'couriers',
  balance: 300_000,
  balance_cash: 300_000,
  balance_card: 0,
});
const marketCashbox = (balance = 1_000_000): Row => ({
  id: 'mk-201',
  user_id: '201',
  cashbox_type: 'markets',
  balance,
  balance_cash: balance,
  balance_card: 0,
});
const openMainShift = (): Row => ({
  id: '31',
  opened_by: '1',
  cashbox_user_id: '0',
  status: 'open',
  opened_at: new Date('2026-10-14T03:00:00Z'),
  opening_balance_cash: 500_000,
  opening_balance_card: 20_000,
});

const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
  } else {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
  }
});

describe('i75GDixP — filial kassasi: manfiy ruxsat faqat aniq tizim bayrog`i bilan', () => {
  it('spendMoney(BRANCH, naqd, balansdan katta) → 400 "Insufficient cash balance", hech narsa saqlanmaydi', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(100_000)] });

    const error = await rpcErrorOf(
      env.service.spendMoney({
        user_id: '15',
        amount: 500_000,
        cashbox_type: 'branch' as any,
        created_by: '208',
      }),
    );

    expect(error).toEqual({
      statusCode: 400,
      message: 'Insufficient cash balance',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('spendMoney(BRANCH, type=click, karta 0) → 400 "Insufficient card balance" (CLICK varianti)', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(900_000, 0)] });

    const error = await rpcErrorOf(
      env.service.spendMoney({
        user_id: '15',
        amount: 50_000,
        type: 'click' as any,
        cashbox_type: 'branch' as any,
        created_by: '208',
      }),
    );

    expect(error).toEqual({
      statusCode: 400,
      message: 'Insufficient card balance',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('spendMoney/fillTheCashbox updateBalance ga allow_negative:false yuboradi', async () => {
    const env = makeEnv({});
    const updateBalance = jest
      .spyOn(env.service, 'updateBalance')
      .mockResolvedValue({ data: {} } as any);

    await env.service.spendMoney({ user_id: '15', amount: 1 });
    await env.service.fillTheCashbox({ user_id: '15', amount: 1 });

    expect(updateBalance.mock.calls[0][0]).toMatchObject({
      allow_negative: false,
      source_type: 'manual_expense',
    });
    expect(updateBalance.mock.calls[1][0]).toMatchObject({
      allow_negative: false,
      source_type: 'manual_income',
    });
  });

  it('updateBalance(SELL, BRANCH, allow_negative:true) manfiyga o`tadi (outbox poison-drop yo`q) va WARN yoziladi', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(100_000)] });
    const warn = jest
      .spyOn((env.service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const res: any = await env.service.updateBalance({
      user_id: '15',
      cashbox_type: 'branch' as any,
      amount: 300_000,
      operation_type: 'expense' as any,
      source_type: 'sell' as any,
      source_id: '777',
      allow_negative: true,
    });

    expect(res.statusCode).toBe(200);
    expect(savedCashbox(env.manager, 'br-15')).toMatchObject({
      balance_cash: -200_000,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('BRANCH kassasi manfiy'),
    );
  });

  it('updateBalance(MANUAL_EXPENSE, BRANCH, balansdan katta) → rad, hatto allow_negative:true bilan ham', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(100_000)] });

    const error = await rpcErrorOf(
      env.service.updateBalance({
        user_id: '15',
        cashbox_type: 'branch' as any,
        amount: 500_000,
        operation_type: 'expense' as any,
        source_type: 'manual_expense' as any,
        allow_negative: true,
      }),
    );

    expect(error).toEqual({
      statusCode: 400,
      message: 'Insufficient cash balance',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('gateway yo`li (allow_negative:false) `source_type: correction` bilan ham filialni manfiyga tushira olmaydi', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(100_000)] });

    const error = await rpcErrorOf(
      env.service.updateBalance({
        user_id: '15',
        cashbox_type: 'branch' as any,
        amount: 500_000,
        operation_type: 'expense' as any,
        source_type: 'correction' as any,
        source_id: '901',
        allow_negative: false,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('aniq bayroq source_type ro`yxatiga bog`liq emas: yangi tizim oyog`i (bills) allow_negative:true bilan o`tadi', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(0)] });

    await env.service.updateBalance({
      user_id: '15',
      cashbox_type: 'branch' as any,
      amount: 10_000,
      operation_type: 'expense' as any,
      source_type: 'bills' as any,
      source_id: '55',
      allow_negative: true,
    });

    expect(savedCashbox(env.manager, 'br-15')).toMatchObject({
      balance_cash: -10_000,
    });
  });

  it('eski outbox qatori (allow_negative yo`q, deploydan oldin navbatga tushgan) SELL oyog`i avvalgidek o`tadi', async () => {
    const env = makeEnv({ cashboxes: [branchCashbox(100_000)] });

    await env.service.updateBalance({
      user_id: '15',
      cashbox_type: 'branch' as any,
      amount: 300_000,
      operation_type: 'expense' as any,
      source_type: 'sell' as any,
      source_id: '778',
    });

    expect(savedCashbox(env.manager, 'br-15')).toMatchObject({
      balance_cash: -200_000,
    });
  });

  it('MAIN kassa allow_negative:true bilan ham manfiyga tushmaydi (bayroq faqat BRANCH uchun)', async () => {
    const env = makeEnv({ cashboxes: [mainCashbox(1_000)] });

    const error = await rpcErrorOf(
      env.service.updateBalance({
        user_id: '0',
        cashbox_type: 'main' as any,
        amount: 5_000,
        operation_type: 'expense' as any,
        source_type: 'sell' as any,
        source_id: '779',
        allow_negative: true,
      }),
    );

    expect(error.statusCode).toBe(400);
  });
});

describe('QTCUUgjA — smena darvozasi (FINANCE_REQUIRE_OPEN_SHIFT)', () => {
  const courierPayment = (extra: Row = {}) => ({
    courier_id: '209',
    amount: 300_000,
    payment_method: 'cash' as any,
    created_by: '1',
    dedup_epoch: 'tok-1',
    ...extra,
  });

  it('darvoza yoqilgan, ochiq smena yo`q: paymentsFromCourier → 400 "Smena ochilmagan", pul ko`chmaydi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [courierCashbox(), mainCashbox()],
      openShift: null,
    });

    const error = await rpcErrorOf(
      env.service.paymentsFromCourier(courierPayment()),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/^Smena ochilmagan/);
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('darvoza yoqilgan, ochiq smena bor: paymentsFromCourier o`tadi; smena FOR SHARE bilan o`qiladi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [courierCashbox(), mainCashbox()],
      openShift: openMainShift(),
    });

    const res: any = await env.service.paymentsFromCourier(courierPayment());

    expect(res.statusCode).toBe(201);
    const shiftCall = env.manager.findOne.mock.calls.find(
      (call) => call[0] === Shift,
    );
    expect(shiftCall?.[1]).toMatchObject({
      where: { cashbox_user_id: '0', status: 'open', isDeleted: false },
      lock: { mode: 'pessimistic_read' },
    });
    expect(savedCashbox(env.manager, 'main-1')).toMatchObject({
      balance_cash: 1_300_000,
    });
  });

  it('sukut (env yo`q) — darvoza o`chiq: smenasiz ham avvalgidek o`tadi, smena so`ralmaydi', async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    const env = makeEnv({
      cashboxes: [courierCashbox(), mainCashbox()],
      openShift: null,
    });

    const res: any = await env.service.paymentsFromCourier(courierPayment());

    expect(res.statusCode).toBe(201);
    expect(
      env.manager.findOne.mock.calls.some((call) => call[0] === Shift),
    ).toBe(false);
  });

  it('menejer yo`li (qabul qiluvchi BRANCH) darvozalanmaydi — filial smenasi hali yo`q', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [courierCashbox(), branchCashbox(0)],
      openShift: null,
    });

    const res: any = await env.service.paymentsFromCourier(
      courierPayment({
        receiver_user_id: '15',
        receiver_cashbox_type: 'branch',
      }),
    );

    expect(res.statusCode).toBe(201);
  });

  it('takroriy so`rov (idempotent) smena yopilgan bo`lsa ham 400 emas, `idempotent` qaytadi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [courierCashbox(), mainCashbox()],
      openShift: null,
    });
    jest
      .spyOn(env.service as any, 'isDuplicateTransfer')
      .mockResolvedValue(true);

    const res: any = await env.service.paymentsFromCourier(courierPayment());

    expect(res.data).toEqual({ idempotent: true });
  });

  it('paymentsToMarket va paymentFromBranchToMain ham smenasiz → 400', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [mainCashbox(), marketCashbox(), branchCashbox(500_000)],
      openShift: null,
    });

    const market = await rpcErrorOf(
      env.service.paymentsToMarket({
        market_id: '201',
        amount: 1_000,
        payment_method: 'cash' as any,
      }),
    );
    const branch = await rpcErrorOf(
      env.service.paymentFromBranchToMain({
        branch_id: '15',
        amount: 1_000,
        payment_method: 'cash' as any,
      }),
    );

    expect(market.message).toMatch(/^Smena ochilmagan/);
    expect(branch.message).toMatch(/^Smena ochilmagan/);
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('spendMoney/fillTheCashbox (MAIN) smenasiz → 400; BRANCH (menejer) darvozalanmaydi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [mainCashbox(), branchCashbox(100_000)],
      openShift: null,
    });

    const spend = await rpcErrorOf(
      env.service.spendMoney({ user_id: '1', amount: 1_000 }),
    );
    const fill = await rpcErrorOf(
      env.service.fillTheCashbox({ user_id: '1', amount: 1_000 }),
    );
    expect(spend.message).toMatch(/^Smena ochilmagan/);
    expect(fill.message).toMatch(/^Smena ochilmagan/);

    const branchSpend: any = await env.service.spendMoney({
      user_id: '15',
      amount: 1_000,
      cashbox_type: 'branch' as any,
    });
    expect(branchSpend.statusCode).toBe(200);
  });

  it('spendMoney (MAIN) ochiq smena bilan o`tadi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = '1';
    const env = makeEnv({
      cashboxes: [mainCashbox(10_000)],
      openShift: openMainShift(),
    });

    const res: any = await env.service.spendMoney({
      user_id: '1',
      amount: 1_000,
    });

    expect(res.statusCode).toBe(200);
    expect(savedCashbox(env.manager, 'main-1')).toMatchObject({
      balance_cash: 9_000,
    });
  });

  it('REGRESSIYA: sotuv (order-service outbox → updateBalance) smena yo`q bo`lsa ham o`tadi — MAIN va BRANCH', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const env = makeEnv({
      cashboxes: [mainCashbox(0), branchCashbox(0)],
      openShift: null,
    });

    const main: any = await env.service.updateBalance({
      user_id: '0',
      cashbox_type: 'main' as any,
      amount: 50_000,
      operation_type: 'income' as any,
      source_type: 'sell' as any,
      source_id: '901',
      dedup_epoch: 'ep-1',
      allow_negative: true,
    });
    const branch: any = await env.service.updateBalance({
      user_id: '15',
      cashbox_type: 'branch' as any,
      amount: 20_000,
      operation_type: 'expense' as any,
      source_type: 'sell' as any,
      source_id: '901',
      dedup_epoch: 'ep-1',
      allow_negative: true,
    });

    expect(main.statusCode).toBe(200);
    expect(branch.statusCode).toBe(200);
    expect(
      env.manager.findOne.mock.calls.some((call) => call[0] === Shift),
    ).toBe(false);
  });
});

describe('R6 (QTCUUgjA) — filial (BRANCH) kassasi smenasi: FINANCE_REQUIRE_OPEN_SHIFT=all', () => {
  const branchShift = (): Row => ({
    ...openMainShift(),
    id: '41',
    opened_by: '25',
    cashbox_user_id: '15',
  });
  const managerCourierPayment = () => ({
    courier_id: '209',
    amount: 300_000,
    payment_method: 'cash' as any,
    created_by: '25',
    dedup_epoch: 'tok-b1',
    receiver_user_id: '15',
    receiver_cashbox_type: 'branch' as any,
  });

  it('⭐ menejer kuryerdan qabul (qabul qiluvchi BRANCH), filial smenasi yo`q → 400 "filial kassasida", pul ko`chmaydi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const env = makeEnv({
      cashboxes: [courierCashbox(), branchCashbox(0)],
      openShifts: { '0': openMainShift() },
    });

    const error = await rpcErrorOf(
      env.service.paymentsFromCourier(managerCourierPayment()),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'Smena ochilmagan! Bu operatsiyani bajarish uchun avval filial kassasida smenani oching.',
    );
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('filial smenasi ochiq → o`tadi; smena filial kassasi (cashbox_user_id=15) bo`yicha FOR SHARE', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const env = makeEnv({
      cashboxes: [courierCashbox(), branchCashbox(0)],
      openShifts: { '15': branchShift() },
    });

    const res: any = await env.service.paymentsFromCourier(
      managerCourierPayment(),
    );

    expect(res.statusCode).toBe(201);
    const shiftCall = env.manager.findOne.mock.calls.find(
      (call) => call[0] === Shift,
    );
    expect(shiftCall?.[1]).toMatchObject({
      where: { cashbox_user_id: '15', status: 'open', isDeleted: false },
      lock: { mode: 'pessimistic_read' },
    });
  });

  it('menejer spend/fill (BRANCH) smenasiz → 400; filial smenasi bilan o`tadi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const closed = makeEnv({
      cashboxes: [branchCashbox(100_000)],
      openShifts: { '0': openMainShift() },
    });
    const spend = await rpcErrorOf(
      closed.service.spendMoney({
        user_id: '15',
        amount: 1_000,
        cashbox_type: 'branch' as any,
      }),
    );
    const fill = await rpcErrorOf(
      closed.service.fillTheCashbox({
        user_id: '15',
        amount: 1_000,
        cashbox_type: 'branch' as any,
      }),
    );
    expect(spend.message).toMatch(/filial kassasida/);
    expect(fill.message).toMatch(/filial kassasida/);

    const open = makeEnv({
      cashboxes: [branchCashbox(100_000)],
      openShifts: { '15': branchShift() },
    });
    const res: any = await open.service.spendMoney({
      user_id: '15',
      amount: 1_000,
      cashbox_type: 'branch' as any,
    });
    expect(res.statusCode).toBe(200);
    expect(savedCashbox(open.manager, 'br-15')).toMatchObject({
      balance_cash: 99_000,
    });
  });

  it('filialdan HQ ga: MAIN smenasi bor, filial smenasi yo`q → 400 (pul filialdan chiqadi); ikkalasi bor → o`tadi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const onlyMain = makeEnv({
      cashboxes: [mainCashbox(), branchCashbox(500_000)],
      openShifts: { '0': openMainShift() },
    });
    const error = await rpcErrorOf(
      onlyMain.service.paymentFromBranchToMain({
        branch_id: '15',
        amount: 1_000,
        payment_method: 'cash' as any,
      }),
    );
    expect(error.message).toMatch(/filial kassasida/);
    expect(onlyMain.manager.save).not.toHaveBeenCalled();

    const both = makeEnv({
      cashboxes: [mainCashbox(), branchCashbox(500_000)],
      openShifts: { '0': openMainShift(), '15': branchShift() },
    });
    const res: any = await both.service.paymentFromBranchToMain({
      branch_id: '15',
      amount: 1_000,
      payment_method: 'cash' as any,
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  it('`true`/`main` qamrovi — filial darvozalanmaydi (2026-10-14 xatti-harakati o`zgarmagan)', async () => {
    for (const value of ['true', 'main']) {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = value;
      const env = makeEnv({
        cashboxes: [courierCashbox(), branchCashbox(0)],
        openShifts: {},
      });
      const res: any = await env.service.paymentsFromCourier(
        managerCourierPayment(),
      );
      expect(res.statusCode).toBe(201);
    }
  });

  it('`main` qamrovi MAIN ni darvozalaydi (true bilan bir xil)', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'main';
    const env = makeEnv({ cashboxes: [mainCashbox()], openShifts: {} });

    const error = await rpcErrorOf(
      env.service.spendMoney({ user_id: '1', amount: 1_000 }),
    );

    expect(error.message).toBe(FinanceServiceService.SHIFT_REQUIRED_MESSAGE);
  });

  it('REGRESSIYA (`all`): sotuv oyog`i (outbox → updateBalance) filial smenasiz ham o`tadi', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const env = makeEnv({
      cashboxes: [mainCashbox(0), branchCashbox(0)],
      openShifts: {},
    });

    const branch: any = await env.service.updateBalance({
      user_id: '15',
      cashbox_type: 'branch' as any,
      amount: 20_000,
      operation_type: 'expense' as any,
      source_type: 'sell' as any,
      source_id: '901',
      dedup_epoch: 'ep-1',
      allow_negative: true,
    });

    expect(branch.statusCode).toBe(200);
    expect(
      env.manager.findOne.mock.calls.some((call) => call[0] === Shift),
    ).toBe(false);
  });

  it('currentShift `required` kassa turiga qarab: all — filial ham; true — faqat MAIN', async () => {
    const shiftRepoFindOne = jest.fn().mockResolvedValue(null);
    const env = makeEnv({ shiftRepoFindOne });

    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const branchAll: any = await env.service.currentShift({
      cashbox_user_id: '15',
    });
    expect(branchAll.data).toMatchObject({
      required: true,
      cashbox_user_id: '15',
    });
    expect(shiftRepoFindOne.mock.calls[0][0].where).toMatchObject({
      cashbox_user_id: '15',
    });

    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const branchMain: any = await env.service.currentShift({
      cashbox_user_id: '15',
    });
    const main: any = await env.service.currentShift({});
    expect(branchMain.data.required).toBe(false);
    expect(main.data.required).toBe(true);
  });

  it('closeShift kassa doirasi bilan: boshqa kassa smenasi (shift_id MAIN) → 404, yopilmaydi', async () => {
    const env = makeEnv({ shiftById: openMainShift() });

    const error = await rpcErrorOf(
      env.service.closeShift({
        shift_id: '31',
        closed_by: '25',
        cashbox_user_id: '15',
      }),
    );

    expect(error).toEqual({
      statusCode: 404,
      message: 'Ochiq smena topilmadi',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('closeShift doira bilan, shift_id yo`q: qidiruv faqat shu filial kassasida (MAIN ga tushmaydi)', async () => {
    const shiftRepoFindOne = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '41' });
    const env = makeEnv({ shiftById: branchShift(), shiftRepoFindOne });

    const res: any = await env.service.closeShift({
      closed_by: '25',
      cashbox_user_id: '15',
    });

    expect(shiftRepoFindOne.mock.calls[0][0].where).toMatchObject({
      opened_by: '25',
      cashbox_user_id: '15',
    });
    expect(shiftRepoFindOne.mock.calls[1][0].where).toMatchObject({
      cashbox_user_id: '15',
      status: 'open',
    });
    expect(res.data).toMatchObject({ status: 'closed', closed_by: '25' });
  });
});

describe('QTCUUgjA — smenani yopishda kutilgan qoldiq va kamomad', () => {
  const totals = [
    { operation_type: 'income', payment_method: 'cash', total: '300000' },
    { operation_type: 'expense', payment_method: 'cash', total: '120000.50' },
    { operation_type: 'income', payment_method: 'click', total: '40000' },
    {
      operation_type: 'expense',
      payment_method: 'click_to_market',
      total: '10000',
    },
  ];

  it('sanalgan summa yuborilsa: expected = opening + kirim − chiqim, discrepancy = sanalgan − expected', async () => {
    const env = makeEnv({ shiftById: openMainShift(), totals });

    const res: any = await env.service.closeShift({
      shift_id: '31',
      closed_by: '1',
      closing_balance_cash: 670_000,
      closing_balance_card: 50_000,
    });

    // 500 000 + 300 000 − 120 000.50 = 679 999.50
    expect(res.data).toMatchObject({
      status: 'closed',
      closed_by: '1',
      total_income_cash: 300_000,
      total_expense_cash: 120_000.5,
      total_income_card: 40_000,
      total_expense_card: 10_000,
      expected_balance_cash: 679_999.5,
      expected_balance_card: 50_000,
      closing_balance_cash: 670_000,
      closing_balance_card: 50_000,
      discrepancy_cash: -9_999.5,
      discrepancy_card: 0,
    });
    // Yig'indi faqat smena kassasi bo'yicha — kassa TURI ham filtrlanadi.
    expect(env.qb.andWhere).toHaveBeenCalledWith('cb.cashbox_type = :cbType', {
      cbType: 'main',
    });
    expect(env.qb.andWhere).toHaveBeenCalledWith('cb.user_id = :ownerId', {
      ownerId: '0',
    });
  });

  it('sanalgan summa yuborilmasa discrepancy NULL (soxta kamomad yo`q), expected baribir saqlanadi', async () => {
    const env = makeEnv({ shiftById: openMainShift(), totals });

    const res: any = await env.service.closeShift({
      shift_id: '31',
      closed_by: '1',
      comment: 'kun yakuni',
    });

    expect(res.data).toMatchObject({
      expected_balance_cash: 679_999.5,
      discrepancy_cash: null,
      discrepancy_card: null,
      closing_balance_cash: 0,
      comment: 'kun yakuni',
    });
  });

  it('manfiy sanalgan summa → 400, smena qulflanmaydi', async () => {
    const env = makeEnv({ shiftById: openMainShift(), totals });

    const error = await rpcErrorOf(
      env.service.closeShift({
        shift_id: '31',
        closed_by: '1',
        closing_balance_cash: -1,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(env.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('filial smenasi yig`indisi BRANCH turi bilan filtrlanadi (bir xil raqamli kuryer kassasi aralashmaydi)', async () => {
    const env = makeEnv({
      shiftById: { ...openMainShift(), cashbox_user_id: '15' },
      totals: [],
    });

    await env.service.closeShift({ shift_id: '31', closed_by: '1' });

    expect(env.qb.andWhere).toHaveBeenCalledWith('cb.cashbox_type = :cbType', {
      cbType: 'branch',
    });
  });
});

describe('kfdfYDik — smenani faqat `{comment}` bilan yopish va joriy smena', () => {
  it('shift_id/opened_by yo`q: yopayotganning o`z ochiq smenasi topiladi', async () => {
    const shiftRepoFindOne = jest.fn().mockResolvedValueOnce({ id: '31' });
    const env = makeEnv({ shiftById: openMainShift(), shiftRepoFindOne });

    const res: any = await env.service.closeShift({
      closed_by: '1',
      comment: 'audit-test',
    });

    expect(res.statusCode).toBe(200);
    expect(shiftRepoFindOne.mock.calls[0][0].where).toMatchObject({
      opened_by: '1',
      status: 'open',
    });
    expect(res.data).toMatchObject({ status: 'closed', closed_by: '1' });
  });

  it('o`z smenasi yo`q bo`lsa MAIN kassaning ochiq smenasi yopiladi', async () => {
    const shiftRepoFindOne = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '31' });
    const env = makeEnv({ shiftById: openMainShift(), shiftRepoFindOne });

    const res: any = await env.service.closeShift({ closed_by: '7' });

    expect(shiftRepoFindOne.mock.calls[1][0].where).toMatchObject({
      cashbox_user_id: '0',
      status: 'open',
    });
    expect(res.data).toMatchObject({ status: 'closed', closed_by: '7' });
  });

  it('ochiq smena umuman yo`q → 404 "Ochiq smena topilmadi"', async () => {
    const env = makeEnv({});

    const error = await rpcErrorOf(env.service.closeShift({ closed_by: '7' }));

    expect(error).toEqual({
      statusCode: 404,
      message: 'Ochiq smena topilmadi',
    });
  });

  it('currentShift: MAIN ochiq smenasi va darvoza holati (`required`)', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'true';
    const shiftRepoFindOne = jest.fn().mockResolvedValue(openMainShift());
    const env = makeEnv({ shiftRepoFindOne });

    const res: any = await env.service.currentShift({});

    expect(res.data).toMatchObject({
      shift: { id: '31', status: 'open' },
      required: true,
      cashbox_user_id: '0',
    });
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    shiftRepoFindOne.mockResolvedValue(null);
    const none: any = await env.service.currentShift();
    expect(none.data).toEqual({
      shift: null,
      required: false,
      cashbox_user_id: '0',
    });
  });

  it('openShift: ochilish qoldig`i berilmasa — kassaning JONLI qoldig`i, kassa qatori FOR UPDATE', async () => {
    const env = makeEnv({ cashboxes: [mainCashbox(80_348_000, 15_000)] });

    const res: any = await env.service.openShift({ opened_by: '1' });

    expect(res.statusCode).toBe(201);
    expect(res.data).toMatchObject({
      opened_by: '1',
      status: 'open',
      cashbox_user_id: '0',
      opening_balance_cash: 80_348_000,
      opening_balance_card: 15_000,
    });
    const cashboxCall = env.manager.findOne.mock.calls.find(
      (call) => call[0] === Cashbox,
    );
    expect(cashboxCall?.[1].lock).toEqual({ mode: 'pessimistic_write' });
    expect(env.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('openShift: shu kassada boshqa odamning ochiq smenasi bor → 400, yozilmaydi', async () => {
    const env = makeEnv({
      cashboxes: [mainCashbox()],
      openShift: { ...openMainShift(), opened_by: '2' },
    });

    const error = await rpcErrorOf(env.service.openShift({ opened_by: '1' }));

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('Bu kassada allaqachon ochiq smena bor');
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('3PE0B03q — "O`tkazma manbasi" transfer_source_user_id ga yoziladi', () => {
  const historyRows = (manager: { save: jest.Mock }) =>
    manager.save.mock.calls
      .map((call) => call[0])
      .filter((row: Row) => row?.source_type);

  it('marketga click to`lov: ikkala tarix qatorida transfer_source_user_id, source_user_id esa market', async () => {
    const env = makeEnv({
      cashboxes: [mainCashbox(0, 500_000), marketCashbox(1_000_000)],
    });

    const res: any = await env.service.paymentsToMarket({
      market_id: '201',
      amount: 1_000,
      payment_method: 'click' as any,
      transfer_source_user_id: '7',
    });

    expect(res.statusCode).toBe(200);
    const rows = historyRows(env.manager);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        payment_method: 'click',
        source_user_id: '201',
        transfer_source_user_id: '7',
      });
    }
  });

  it('filialdan HQ ga click: ikkala qatorda transfer_source_user_id; naqdda NULL', async () => {
    const env = makeEnv({
      cashboxes: [mainCashbox(), branchCashbox(500_000, 500_000)],
    });

    await env.service.paymentFromBranchToMain({
      branch_id: '15',
      amount: 1_000,
      payment_method: 'click' as any,
      transfer_source_user_id: '7',
    });
    const clickRows = historyRows(env.manager);
    expect(clickRows.map((row) => row.transfer_source_user_id)).toEqual([
      '7',
      '7',
    ]);
    expect(clickRows.every((row) => row.source_user_id === '15')).toBe(true);

    env.manager.save.mockClear();
    await env.service.paymentFromBranchToMain({
      branch_id: '15',
      amount: 1_000,
      payment_method: 'cash' as any,
      transfer_source_user_id: '7',
    });
    expect(
      historyRows(env.manager).map((row) => row.transfer_source_user_id),
    ).toEqual([null, null]);
  });

  it('noto`g`ri (raqam emas) manba → 400, pul ko`chmaydi', async () => {
    const env = makeEnv({ cashboxes: [mainCashbox(), marketCashbox()] });

    const error = await rpcErrorOf(
      env.service.paymentsToMarket({
        market_id: '201',
        amount: 1_000,
        payment_method: 'click' as any,
        transfer_source_user_id: 'abc',
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(env.manager.save).not.toHaveBeenCalled();
  });
});
