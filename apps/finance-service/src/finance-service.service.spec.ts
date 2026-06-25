import { FinanceServiceService } from './finance-service.service';

const captureExceptionMock = jest.fn();

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  Cashbox_type: {
    MAIN: 'main',
    FOR_COURIER: 'for_courier',
    FOR_MARKET: 'for_market',
    BRANCH: 'branch',
  },
  Operation_type: { INCOME: 'income', EXPENSE: 'expense' },
  Source_type: {
    BRANCH_TO_MAIN: 'branch_to_main',
    SELL: 'sell',
    COURIER_PAYMENT: 'courier_payment',
    MARKET_PAYMENT: 'market_payment',
    EXTRA_COST: 'extra_cost',
    MANUAL_INCOME: 'manual_income',
    MANUAL_EXPENSE: 'manual_expense',
  },
  PaymentMethod: {
    CASH: 'cash',
    CARD: 'card',
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
  captureException: (...args: any[]) => captureExceptionMock(...args),
  rmqSend: (...args: any[]) => rmqSendMock(...args),
}));

// Shape stub for entity classes — Jest doesn't need real metadata when we
// only assert on save() inputs, not TypeORM behaviour itself.
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

interface MockManager {
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

interface MockQueryRunner {
  manager: MockManager;
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
  release: jest.Mock;
  query: jest.Mock;
}

function makeQueryRunner(manager: MockManager): MockQueryRunner {
  return {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
  };
}

function makeManager(overrides: Partial<MockManager> = {}): MockManager {
  return {
    findOne: jest.fn(),
    save: jest.fn(async (entity: any) => ({ id: '99', ...entity })),
    create: jest.fn((_entity: any, dto: any) => dto),
    ...overrides,
  };
}

function makeService(manager: MockManager) {
  const queryRunner = makeQueryRunner(manager);
  const dataSource: any = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const cashboxRepo: any = { findOne: jest.fn(), save: jest.fn() };
  const historyRepo: any = {
    find: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const shiftRepo: any = { findOne: jest.fn(), save: jest.fn() };
  const salaryRepo: any = {};
  const earningRepo: any = {
    findOne: jest.fn(),
    save: jest.fn(async (entity: any) => ({ id: 'e1', ...entity })),
    create: jest.fn((dto: any) => dto),
    createQueryBuilder: jest.fn(),
    findAndCount: jest.fn(),
  };
  const paymentRepo: any = {
    findOne: jest.fn(),
    save: jest.fn(async (entity: any) => ({ id: 'p1', ...entity })),
    create: jest.fn((dto: any) => dto),
    createQueryBuilder: jest.fn(),
    findAndCount: jest.fn(),
  };
  const financialHistoryRepo: any = {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
    }),
    findByEntity: jest.fn().mockResolvedValue([]),
    findByUser: jest.fn().mockResolvedValue([]),
  };
  const orderClient: any = {};
  const identityClient: any = {};
  const outbox: any = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = new FinanceServiceService(
    cashboxRepo,
    historyRepo,
    shiftRepo,
    salaryRepo,
    earningRepo,
    paymentRepo,
    financialHistoryRepo,
    dataSource,
    activityLog,
    orderClient,
    identityClient,
    outbox,
  );

  return {
    service,
    queryRunner,
    dataSource,
    cashboxRepo,
    historyRepo,
    earningRepo,
    paymentRepo,
    financialHistoryRepo,
    activityLog,
    outbox,
  };
}

describe('FinanceServiceService.findCashboxByUser', () => {
  it('filters typed cashbox history by the requested source type', async () => {
    const manager = makeManager();
    const { service, cashboxRepo, historyRepo } = makeService(manager);
    const cashbox = {
      id: '16',
      user_id: '24',
      cashbox_type: 'markets',
      balance: 30290000,
    };
    const marketPayment = {
      id: '50',
      cashbox_id: '16',
      source_type: 'market_payment',
      amount: 1000000,
    };

    cashboxRepo.findOne.mockResolvedValue(cashbox);
    historyRepo.findAndCount.mockResolvedValue([[marketPayment], 1]);

    const response = await service.findCashboxByUser({
      user_id: '24',
      cashbox_type: 'markets' as any,
      history_source_type: 'market_payment' as any,
      with_history: true,
      page: 1,
      limit: 20,
    });

    expect(historyRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cashbox_id: '16',
          isDeleted: false,
          source_type: 'market_payment',
        },
      }),
    );
    expect(response.data.history).toEqual([marketPayment]);
    expect(response.data.pagination.total).toBe(1);
  });
});

describe('FinanceServiceService.myCashbox', () => {
  it('shows only HQ-market payment history for market users', async () => {
    const manager = makeManager();
    const { service, cashboxRepo, historyRepo } = makeService(manager);
    const cashbox = {
      id: '16',
      user_id: '24',
      cashbox_type: 'markets',
      balance: 4950000,
    };
    const hqMarketPayment = {
      id: '90',
      cashbox_id: '16',
      source_type: 'market_payment',
      amount: 1950000,
    };

    cashboxRepo.findOne.mockResolvedValue(cashbox);
    historyRepo.find.mockResolvedValue([hqMarketPayment]);

    const response = await service.myCashbox({
      user_id: '24',
      roles: ['market'],
    });

    expect(historyRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cashbox_id: '16',
          isDeleted: false,
          source_type: 'market_payment',
        },
      }),
    );
    expect(response.data.cashboxHistory).toEqual([hqMarketPayment]);
  });

  it('shows only HQ-branch payment history for manager users', async () => {
    const manager = makeManager();
    const { service, cashboxRepo, historyRepo } = makeService(manager);
    const cashbox = {
      id: '20',
      user_id: '7',
      cashbox_type: 'branch',
      balance: 1000000,
    };
    const branchPayment = {
      id: '91',
      cashbox_id: '20',
      source_type: 'branch_to_main',
      amount: 1000000,
    };

    cashboxRepo.findOne.mockResolvedValue(cashbox);
    historyRepo.find.mockResolvedValue([branchPayment]);

    const response = await service.myCashbox({
      user_id: '55',
      branch_id: '7',
      roles: ['manager'],
    });

    expect(historyRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cashbox_id: '20',
          isDeleted: false,
          source_type: 'branch_to_main',
        },
      }),
    );
    expect(response.data.cashboxHistory).toEqual([branchPayment]);
  });

  it('shows only manager-courier payment history for courier users', async () => {
    const manager = makeManager();
    const { service, cashboxRepo, historyRepo } = makeService(manager);
    const cashbox = {
      id: '21',
      user_id: '8',
      cashbox_type: 'for_courier',
      balance: 500000,
    };
    const courierPayment = {
      id: '92',
      cashbox_id: '21',
      source_type: 'courier_payment',
      amount: 500000,
    };

    cashboxRepo.findOne.mockResolvedValue(cashbox);
    historyRepo.find.mockResolvedValue([courierPayment]);

    const response = await service.myCashbox({
      user_id: '8',
      roles: ['courier'],
    });

    expect(historyRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cashbox_id: '21',
          isDeleted: false,
          source_type: 'courier_payment',
        },
      }),
    );
    expect(response.data.cashboxHistory).toEqual([courierPayment]);
  });
});

describe('FinanceServiceService.financialBalance', () => {
  it('uses main + branch receivable - market payable', async () => {
    const manager = makeManager();
    const { service, cashboxRepo } = makeService(manager);
    cashboxRepo.findOne.mockResolvedValue({
      id: 'main-1',
      user_id: '0',
      cashbox_type: 'main',
      balance: 500000,
    });
    cashboxRepo.find = jest
      .fn()
      .mockResolvedValue([
        { id: 'market-cashbox', user_id: '20', balance: 999999 },
      ]);
    rmqSendMock.mockResolvedValue({
      data: {
        branch_receivable: 200000,
        market_payable: 150000,
        branches: [{ branch_id: '10', amount: 200000 }],
        markets: [{ market_id: '20', amount: 150000 }],
      },
    });

    const response: any = await service.financialBalance();

    expect(response.data.currentSituation).toBe(550000);
    expect(response.data.branches.branchReceivable).toBe(200000);
    expect(response.data.markets.marketPayable).toBe(150000);
    expect(response.data.markets.marketsTotalBalans).toBe(-150000);
    expect(response.data.couriers.couriersTotalBalanse).toBe(0);
    expect(response.data.formula).toBe(
      'main_cashbox + branch_receivable - market_payable',
    );
  });
});

describe('FinanceServiceService.updateBalance', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it('returns idempotent response when history row already exists for the same source', async () => {
    const existingCashbox = {
      id: '10',
      balance: 1000,
      balance_cash: 1000,
      balance_card: 0,
      user_id: '7',
      cashbox_type: 'for_courier',
    };
    const existingHistory = {
      id: 'h1',
      cashbox_id: '10',
      source_type: 'sell',
      source_id: '42',
      operation_type: 'income',
      amount: 500,
    };

    const manager = makeManager({
      findOne: jest
        .fn()
        // first call: getCashboxBySelectorWithManager (locked cashbox lookup)
        .mockResolvedValueOnce(existingCashbox)
        // second call: idempotency history lookup
        .mockResolvedValueOnce(existingHistory),
    });

    const { service, queryRunner } = makeService(manager);

    const res = await service.updateBalance({
      cashbox_id: '10',
      amount: 500,
      operation_type: 'income' as any,
      source_type: 'sell' as any,
      source_id: '42',
    } as any);

    // Cashbox NOT saved a second time → balance left intact
    expect(manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      statusCode: 200,
      data: { idempotent: true, history: existingHistory },
    });
  });

  it('applies the balance and writes history on a first delivery (source_id present)', async () => {
    const cashbox = {
      id: '10',
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
      user_id: '7',
      cashbox_type: 'for_courier',
    };

    const manager = makeManager({
      findOne: jest
        .fn()
        .mockResolvedValueOnce(cashbox)
        // no existing history → first delivery
        .mockResolvedValueOnce(null),
      save: jest
        .fn()
        // 1st save: cashbox with updated balance
        .mockImplementationOnce(async (entity: any) => ({
          ...entity,
          id: '10',
        }))
        // 2nd save: history row
        .mockImplementationOnce(async (entity: any) => ({
          ...entity,
          id: 'h-new',
        })),
    });

    const { service, queryRunner } = makeService(manager);

    const res = await service.updateBalance({
      cashbox_id: '10',
      amount: 500,
      operation_type: 'income' as any,
      source_type: 'sell' as any,
      source_id: '42',
      payment_method: 'cash' as any,
    } as any);

    // Cashbox AND history both persisted
    expect(manager.save).toHaveBeenCalledTimes(2);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    // Income increases balance_cash by amount
    const savedCashbox = manager.save.mock.calls[0][0];
    expect(savedCashbox.balance_cash).toBe(500);
    // History row snapshots the cash/card split after the operation, not just
    // the total — cash payment leaves 500 in cash, 0 on card.
    const savedHistory = manager.save.mock.calls[1][0];
    expect(savedHistory.balance_after).toBe(500);
    expect(savedHistory.balance_cash_after).toBe(500);
    expect(savedHistory.balance_card_after).toBe(0);
    expect(res.statusCode).toBe(200);
  });

  it('skips the idempotency pre-check when source_id is absent (manual adjustment)', async () => {
    const cashbox = {
      id: '10',
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
      user_id: '7',
      cashbox_type: 'main',
    };

    const manager = makeManager({
      // Only the cashbox lookup runs — no idempotency lookup
      findOne: jest.fn().mockResolvedValueOnce(cashbox),
    });

    const { service, queryRunner } = makeService(manager);

    await service.updateBalance({
      cashbox_id: '10',
      amount: 100,
      operation_type: 'income' as any,
      source_type: 'sell' as any,
      // no source_id
    } as any);

    expect(manager.findOne).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('acquires a pessimistic_write lock on the cashbox row', async () => {
    const cashbox = {
      id: '10',
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
      user_id: '7',
      cashbox_type: 'main',
    };

    const manager = makeManager({
      findOne: jest
        .fn()
        .mockResolvedValueOnce(cashbox)
        .mockResolvedValueOnce(null),
    });

    const { service } = makeService(manager);

    await service.updateBalance({
      cashbox_id: '10',
      amount: 50,
      operation_type: 'income' as any,
      source_type: 'sell' as any,
      source_id: '99',
    } as any);

    const firstCall = manager.findOne.mock.calls[0];
    // [Cashbox, { where: {...}, lock: { mode: 'pessimistic_write' } }]
    expect(firstCall[1].lock).toEqual({ mode: 'pessimistic_write' });
  });

  it('rolls back the transaction on save failure', async () => {
    const cashbox = {
      id: '10',
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
      user_id: '7',
      cashbox_type: 'main',
    };

    const manager = makeManager({
      findOne: jest
        .fn()
        .mockResolvedValueOnce(cashbox)
        .mockResolvedValueOnce(null),
      save: jest.fn().mockRejectedValueOnce(new Error('db blip')),
    });

    const { service, queryRunner } = makeService(manager);

    await expect(
      service.updateBalance({
        cashbox_id: '10',
        amount: 50,
        operation_type: 'income' as any,
        source_type: 'sell' as any,
        source_id: '99',
      } as any),
    ).rejects.toBeTruthy();

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});

describe('FinanceServiceService operator earnings & payments', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    rmqSendMock.mockReset();
  });

  it('records a PERCENT commission earning for a sold order', async () => {
    const manager = makeManager();
    const { service, earningRepo, activityLog } = makeService(manager);

    // identity returns the operator's commission config
    rmqSendMock.mockResolvedValueOnce({
      data: { commission_type: 'percent', commission_value: 5 },
    });
    earningRepo.findOne.mockResolvedValueOnce(null); // no existing earning

    const res = await service.recordOperatorEarning({
      order_id: '1001',
      operator_id: '42',
      market_id: '7',
      total_price: 200000,
    });

    expect(res.statusCode).toBe(201);
    // 5% of 200000 = 10000
    expect(earningRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 10000,
        operator_id: '42',
        order_id: '1001',
      }),
    );
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('records a FIXED commission regardless of total_price', async () => {
    const manager = makeManager();
    const { service, earningRepo } = makeService(manager);

    rmqSendMock.mockResolvedValueOnce({
      data: { commission_type: 'fixed', commission_value: 3000 },
    });
    earningRepo.findOne.mockResolvedValueOnce(null);

    await service.recordOperatorEarning({
      order_id: '1002',
      operator_id: '42',
      total_price: 999999,
    });

    expect(earningRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3000 }),
    );
  });

  it('skips earning when the operator has no commission config', async () => {
    const manager = makeManager();
    const { service, earningRepo } = makeService(manager);

    rmqSendMock.mockResolvedValueOnce({
      data: { commission_type: null, commission_value: 0 },
    });

    const res = await service.recordOperatorEarning({
      order_id: '1003',
      operator_id: '42',
      total_price: 200000,
    });

    expect(res.message).toMatch(/skipped/);
    expect(earningRepo.save).not.toHaveBeenCalled();
  });

  it('skips earning for orders with no operator', async () => {
    const manager = makeManager();
    const { service, earningRepo } = makeService(manager);

    const res = await service.recordOperatorEarning({
      order_id: '1004',
      operator_id: null,
      total_price: 200000,
    });

    expect(res.message).toMatch(/no operator/);
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(earningRepo.save).not.toHaveBeenCalled();
  });

  it('updates an existing earning instead of inserting a duplicate (idempotent)', async () => {
    const manager = makeManager();
    const { service, earningRepo } = makeService(manager);

    rmqSendMock.mockResolvedValueOnce({
      data: { commission_type: 'percent', commission_value: 10 },
    });
    earningRepo.findOne.mockResolvedValueOnce({
      id: 'e9',
      order_id: '1005',
      amount: 5000,
    });

    const res = await service.recordOperatorEarning({
      order_id: '1005',
      operator_id: '42',
      total_price: 100000,
    });

    expect(res.message).toMatch(/updated/);
    // 10% of 100000 = 10000 overwrites the prior 5000
    expect(earningRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e9', amount: 10000 }),
    );
  });

  it('soft-removes an earning on rollback', async () => {
    const manager = makeManager();
    const { service, earningRepo, activityLog } = makeService(manager);

    earningRepo.findOne.mockResolvedValueOnce({
      id: 'e7',
      order_id: '1006',
      amount: 8000,
    });

    const res = await service.removeOperatorEarning({ order_id: '1006' });

    expect(res.statusCode).toBe(200);
    expect(earningRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e7', isDeleted: true }),
    );
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('computes operator balance as earned - paid', async () => {
    const manager = makeManager();
    const { service, earningRepo, paymentRepo } = makeService(manager);

    earningRepo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '50000' }),
    });
    paymentRepo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '20000' }),
    });

    const res = await service.findOperatorBalance({ operator_id: '42' });

    expect(res.data).toMatchObject({
      earned: 50000,
      paid: 20000,
      balance: 30000,
    });
  });

  it('records an operator payment', async () => {
    const manager = makeManager();
    const { service, paymentRepo, activityLog } = makeService(manager);

    const res = await service.createOperatorPayment({
      operator_id: '42',
      amount: 15000,
      paid_by_id: '1',
      note: 'monthly',
    });

    expect(res.statusCode).toBe(201);
    expect(paymentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 15000, operator_id: '42' }),
    );
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('rejects a non-positive payment amount', async () => {
    const manager = makeManager();
    const { service } = makeService(manager);

    await expect(
      service.createOperatorPayment({ operator_id: '42', amount: 0 }),
    ).rejects.toBeTruthy();
  });
});

describe('FinanceServiceService manual branch cashbox operations', () => {
  it('records manager manual income in the branch cashbox with manager as creator', async () => {
    const manager = makeManager();
    const { service } = makeService(manager);
    const updateBalance = jest
      .spyOn(service, 'updateBalance')
      .mockResolvedValue({ data: { id: 'history-1' } } as any);

    await service.fillTheCashbox({
      user_id: '13',
      created_by: '54',
      amount: 150000,
      cashbox_type: 'branch' as any,
    });

    expect(updateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '13',
        created_by: '54',
        amount: 150000,
        cashbox_type: 'branch',
        source_type: 'manual_income',
        operation_type: 'income',
      }),
    );
  });

  it('records manager manual expense in the branch cashbox with manager as creator', async () => {
    const manager = makeManager();
    const { service } = makeService(manager);
    const updateBalance = jest
      .spyOn(service, 'updateBalance')
      .mockResolvedValue({ data: { id: 'history-2' } } as any);

    await service.spendMoney({
      user_id: '13',
      created_by: '54',
      amount: 50000,
      cashbox_type: 'branch' as any,
    });

    expect(updateBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '13',
        created_by: '54',
        amount: 50000,
        cashbox_type: 'branch',
        source_type: 'manual_expense',
        operation_type: 'expense',
      }),
    );
  });
});

describe('FinanceServiceService financial balance ledger', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    rmqSendMock.mockReset();
  });

  it('appends a ledger entry with running balance from the previous row', async () => {
    const manager = makeManager({
      findOne: jest
        .fn()
        // idempotency check (order_id present) → none
        .mockResolvedValueOnce(null)
        // last row → previous balance 100000
        .mockResolvedValueOnce({ balance_after: 100000 }),
      create: jest.fn((_e: any, dto: any) => dto),
      save: jest.fn(async (e: any) => ({ id: 'fbh1', ...e })),
    });
    const { service, queryRunner, activityLog } = makeService(manager);

    const res = await service.recordFinancialBalance({
      amount: 25000,
      source_type: 'sell_profit' as any,
      order_id: '1001',
    });

    expect(res.statusCode).toBe(201);
    // balance_before = 100000, balance_after = 125000
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 25000,
        balance_before: 100000,
        balance_after: 125000,
      }),
    );
    // advisory lock acquired before reading the running total
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.anything(),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('starts the ledger at 0 when there is no prior row', async () => {
    const manager = makeManager({
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null) // no order_id idempotency hit
        .mockResolvedValueOnce(null), // no previous row
      create: jest.fn((_e: any, dto: any) => dto),
      save: jest.fn(async (e: any) => ({ id: 'fbh1', ...e })),
    });
    const { service } = makeService(manager);

    await service.recordFinancialBalance({
      amount: -40000,
      source_type: 'manual_expense' as any,
    });

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: -40000,
        balance_before: 0,
        balance_after: -40000,
      }),
    );
  });

  it('is idempotent for order-linked entries — returns existing row', async () => {
    const manager = makeManager({
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ id: 'fbh-old', balance_after: 5000 }),
      create: jest.fn(),
      save: jest.fn(),
    });
    const { service, queryRunner } = makeService(manager);

    const res = await service.recordFinancialBalance({
      amount: 25000,
      source_type: 'sell_profit' as any,
      order_id: '1001',
    });

    expect(res.message).toMatch(/already recorded/);
    expect(manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips a zero-amount entry without opening a transaction', async () => {
    const manager = makeManager();
    const { service, dataSource } = makeService(manager);

    const res = await service.recordFinancialBalance({
      amount: 0,
      source_type: 'correction' as any,
    });

    expect(res.message).toMatch(/zero amount/);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('returns history rows plus the current balance', async () => {
    const manager = makeManager();
    const { service, financialHistoryRepo } = makeService(manager);

    financialHistoryRepo.findAndCount.mockResolvedValue([
      [
        { id: '2', amount: 25000 },
        { id: '1', amount: 100000 },
      ],
      2,
    ]);
    financialHistoryRepo.findOne.mockResolvedValue({ balance_after: 125000 });

    const res = await service.findFinancialBalanceHistory({ limit: 10 });

    expect(res.data.total).toBe(2);
    expect(res.data.currentBalance).toBe(125000);
    expect(res.data.rows).toHaveLength(2);
  });
});

describe('FinanceServiceService.paymentsFromCourier over-remit guard (Faza 1c)', () => {
  it('rejects a remit larger than the courier cashbox balance (no negative drive)', async () => {
    const manager = makeManager();
    // 1st findOne → courier cashbox (balance 500); 2nd findOne → duplicate
    // pre-check returns null (not a replay) so we reach the over-remit guard.
    manager.findOne
      .mockResolvedValueOnce({
        id: 'cb-courier',
        user_id: '7',
        cashbox_type: 'for_courier',
        balance: 500,
        balance_cash: 500,
        balance_card: 0,
      })
      .mockResolvedValueOnce(null);
    const { service } = makeService(manager);

    await expect(
      service.paymentsFromCourier({
        courier_id: '7',
        amount: 1000, // > 500 balance
        payment_method: 'cash' as any,
        dedup_epoch: 'tok-new',
      }),
    ).rejects.toThrow();

    // The cashbox was never saved (no balance mutation) — guard fired first.
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('returns idempotent for a replay BEFORE the over-remit guard runs', async () => {
    const manager = makeManager();
    // Courier cashbox at balance 0; duplicate pre-check finds an existing row.
    manager.findOne
      .mockResolvedValueOnce({
        id: 'cb-courier',
        user_id: '7',
        cashbox_type: 'for_courier',
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      })
      .mockResolvedValueOnce({ id: 'existing-history-row' });
    const { service, outbox } = makeService(manager);

    // amount 1000 > balance 0, but the replay short-circuits first → no throw.
    const res: any = await service.paymentsFromCourier({
      courier_id: '7',
      amount: 1000,
      payment_method: 'cash' as any,
      dedup_epoch: 'tok-replayed',
    });

    expect(res.data.idempotent).toBe(true);
    // A replay must NOT enqueue another settlement advance (the original did).
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('FinanceServiceService.paymentsFromCourier settlement advance via outbox (Faza 2a)', () => {
  it('enqueues order.settlement.advance INSIDE the cashbox tx, keyed by the payment token', async () => {
    const manager = makeManager();
    manager.findOne
      // 1) courier cashbox (balance covers the remit)
      .mockResolvedValueOnce({
        id: 'cb-courier',
        user_id: '7',
        cashbox_type: 'for_courier',
        balance: 1000,
        balance_cash: 1000,
        balance_card: 0,
      })
      // 2) duplicate pre-check → not a replay
      .mockResolvedValueOnce(null)
      // 3) receiver (main) cashbox
      .mockResolvedValueOnce({
        id: 'cb-main',
        user_id: '1',
        cashbox_type: 'main',
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      });
    const { service, queryRunner, outbox } = makeService(manager);

    await service.paymentsFromCourier({
      courier_id: '7',
      amount: 1000,
      payment_method: 'cash' as any,
      created_by: '42',
      dedup_epoch: 'tok-1',
    });

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'ORDER',
      'order.settlement.advance',
      expect.objectContaining({
        level: 'courier_to_branch',
        match_value: '7',
        amount: 1000,
        requester_id: '42',
      }),
      expect.objectContaining({
        manager: queryRunner.manager,
        requestId: 'tok-1',
      }),
    );
    // The outbox row is written before the transaction commits (atomicity).
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });
});
