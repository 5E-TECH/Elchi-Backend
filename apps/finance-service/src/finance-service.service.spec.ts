import { FinanceServiceService } from './finance-service.service';

const captureExceptionMock = jest.fn();

jest.mock('@app/common', () => ({
  Cashbox_type: { MAIN: 'main', FOR_COURIER: 'for_courier', FOR_MARKET: 'for_market' },
  Operation_type: { INCOME: 'income', EXPENSE: 'expense' },
  Source_type: { SELL: 'sell', COURIER_PAYMENT: 'courier_payment', MARKET_PAYMENT: 'market_payment', EXTRA_COST: 'extra_cost' },
  PaymentMethod: { CASH: 'cash', CARD: 'card', CLICK_TO_MARKET: 'click_to_market' },
  captureException: (...args: any[]) => captureExceptionMock(...args),
}));

// Shape stub for entity classes — Jest doesn't need real metadata when we
// only assert on save() inputs, not TypeORM behaviour itself.
jest.mock('./entities/cashbox.entity', () => ({ Cashbox: class Cashbox {} }));
jest.mock('./entities/cashbox-history.entity', () => ({ CashboxHistory: class CashboxHistory {} }));
jest.mock('./entities/shift.entity', () => ({ Shift: class Shift {}, ShiftStatus: { OPEN: 'open', CLOSED: 'closed' } }));
jest.mock('./entities/user-salary.entity', () => ({ UserSalary: class UserSalary {} }));

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
}

function makeQueryRunner(manager: MockManager): MockQueryRunner {
  return {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
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
  const historyRepo: any = {};
  const shiftRepo: any = { findOne: jest.fn(), save: jest.fn() };
  const salaryRepo: any = {};
  const orderClient: any = {};
  const identityClient: any = {};

  const service = new FinanceServiceService(
    cashboxRepo,
    historyRepo,
    shiftRepo,
    salaryRepo,
    dataSource,
    orderClient,
    identityClient,
  );

  return { service, queryRunner, dataSource, cashboxRepo };
}

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
        .mockImplementationOnce(async (entity: any) => ({ ...entity, id: '10' }))
        // 2nd save: history row
        .mockImplementationOnce(async (entity: any) => ({ ...entity, id: 'h-new' })),
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
      findOne: jest.fn().mockResolvedValueOnce(cashbox).mockResolvedValueOnce(null),
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
      findOne: jest.fn().mockResolvedValueOnce(cashbox).mockResolvedValueOnce(null),
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
