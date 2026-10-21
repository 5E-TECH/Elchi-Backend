import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Operation_type, Source_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxExpenseCategory } from './entities/cashbox-expense-category.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';

/**
 * Elchi Pochta №1 — "To'lovlar → Kassa → xarajat" (`spendMoney` →
 * `updateBalance`, HAQIQIY pul mantig'i, tranzaksiya mock): tanlangan
 * kategoriya tarix qatoriga id + nom snapshot'i bo'lib yoziladi, o'chirilgan
 * kategoriya — 400 va hech narsa o'zgarmaydi, kategoriyasiz chiqim avvalgidek.
 */

type Row = Record<string, unknown>;
type Res<T> = { statusCode: number; message: string; data: T };
type HistoryRow = {
  id: string;
  expense_category_id: string | null;
  expense_category_name: string | null;
};
type AuditEntry = {
  action: string;
  description: string;
  new_value: Row;
  metadata: Row;
};

/** Servis javobi (`successRes`) — test ichida aniq tur bilan. */
const result = async <T>(promise: Promise<unknown>) =>
  (await promise) as Res<T>;

function makeEnv(options: { category?: Row | null; replay?: Row } = {}) {
  let seq = 0;
  const main: Row = {
    id: 'cb-main',
    user_id: '0',
    cashbox_type: 'main',
    balance: 1_000_000,
    balance_cash: 800_000,
    balance_card: 200_000,
  };
  const manager = {
    findOne: jest.fn((entity: unknown) => {
      if (entity === CashboxHistory) {
        return Promise.resolve(options.replay ?? null);
      }
      if (entity === CashboxExpenseCategory) {
        return Promise.resolve(options.category ?? null);
      }
      if (entity === FinancialBalanceHistory) {
        return Promise.resolve({ id: '55', balance_after: 5_000_000 });
      }
      return Promise.resolve(null);
    }),
    save: jest.fn((entity: Row) =>
      Promise.resolve(entity?.id ? entity : { ...entity, id: `h-${++seq}` }),
    ),
    create: jest.fn((entity: unknown, dto: Row) => ({
      __entity: entity,
      ...dto,
    })),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const queryRunner = {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new FinanceServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never,
    activityLog as never,
    { send: jest.fn(() => of({ statusCode: 200 })) } as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
  );
  jest
    .spyOn(service as any, 'getCashboxBySelectorWithManager')
    .mockResolvedValue(main);
  const historyCreates = () =>
    manager.create.mock.calls
      .filter(([entity]) => entity === CashboxHistory)
      .map(([, dto]) => dto);
  /** `finance.manual_expense` audit yozuvi (bo'lmasa undefined). */
  const manualExpenseAudit = () =>
    (activityLog.log.mock.calls as Array<[AuditEntry]>)
      .map(([entry]) => entry)
      .find((entry) => entry.action === 'finance.manual_expense');
  return {
    service,
    manager,
    queryRunner,
    activityLog,
    main,
    historyCreates,
    manualExpenseAudit,
  };
}

/** Gateway `PATCH /finance/cashbox/spend` yuboradigan payload. */
const spendPayload = (extra: { expense_category_id?: string } = {}) => ({
  user_id: '9',
  amount: 150_000,
  comment: 'Benzin',
  created_by: '9',
  dedup_epoch: 'idem-spend-1',
  financial_ledger: true,
  ...extra,
});

describe('Elchi Pochta №1 — qo`lda chiqimda xarajat kategoriyasi', () => {
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;
  beforeEach(() => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
  });
  afterAll(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
  });

  it('⭐ kategoriya bilan: tarix qatorida id + nom snapshot, javobda ham; audit gapida kategoriya nomi', async () => {
    const env = makeEnv({
      category: { id: '2', name: "Yoqilg'i", isDeleted: false },
    });
    const res = await result<{ history: HistoryRow }>(
      env.service.spendMoney(spendPayload({ expense_category_id: '2' })),
    );

    expect(env.manager.findOne).toHaveBeenCalledWith(CashboxExpenseCategory, {
      where: { id: '2', isDeleted: false },
      lock: { mode: 'pessimistic_read' },
    });
    expect(env.historyCreates()).toEqual([
      expect.objectContaining({
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.MANUAL_EXPENSE,
        amount: 150_000,
        expense_category_id: '2',
        expense_category_name: "Yoqilg'i",
      }),
    ]);
    expect(res.data.history).toMatchObject({
      expense_category_id: '2',
      expense_category_name: "Yoqilg'i",
    });
    // Pul mantig'i o'zgarmagan: naqd chiqim, bitta commit.
    expect(env.main.balance_cash).toBe(650_000);
    expect(env.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);

    expect(env.manualExpenseAudit()).toMatchObject({
      new_value: {
        amount: 150_000,
        expense_category: { id: '2', name: "Yoqilg'i" },
      },
      metadata: { expense_category_id: '2' },
      description:
        "Kassadan chiqim: 150 000 so'm (Asosiy kassa, naqd) — Yoqilg'i",
    });
  });

  it('⭐ o`chirilgan / mavjud bo`lmagan kategoriya — 400: rollback, kassa ham, tarix ham yozilmaydi', async () => {
    const env = makeEnv({ category: null });
    let error: unknown;
    try {
      await env.service.spendMoney(spendPayload({ expense_category_id: '7' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
    expect(payload.statusCode).toBe(400);
    expect(payload.message).toContain('Xarajat kategoriyasi topilmadi');
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.historyCreates()).toHaveLength(0);
    expect(env.main.balance_cash).toBe(800_000);
    expect(env.activityLog.log).not.toHaveBeenCalled();
  });

  it('kategoriyasiz chiqim — avvalgidek: kategoriya so`ralmaydi, tarixda NULL, audit gapi o`zgarmagan', async () => {
    const env = makeEnv();
    await env.service.spendMoney(spendPayload());

    expect(env.manager.findOne).not.toHaveBeenCalledWith(
      CashboxExpenseCategory,
      expect.anything(),
    );
    expect(env.historyCreates()[0]).toMatchObject({
      expense_category_id: null,
      expense_category_name: null,
    });
    const audit = env.manualExpenseAudit();
    expect(audit?.description).toBe(
      "Kassadan chiqim: 150 000 so'm (Asosiy kassa, naqd)",
    );
    expect(audit?.new_value).not.toHaveProperty('expense_category');
  });

  it('takroriy so`rov (Idempotency-Key) — kategoriya keyin o`chirilgan bo`lsa ham avvalgi natija, qayta tekshirilmaydi', async () => {
    const env = makeEnv({
      category: null,
      replay: {
        id: 'h-old',
        amount: 150_000,
        expense_category_id: '2',
        expense_category_name: "Yoqilg'i",
      },
    });
    const res = await result<{ idempotent: boolean; history: HistoryRow }>(
      env.service.spendMoney(spendPayload({ expense_category_id: '2' })),
    );
    expect(res.data.idempotent).toBe(true);
    expect(res.data.history.expense_category_name).toBe("Yoqilg'i");
    expect(env.manager.findOne).not.toHaveBeenCalledWith(
      CashboxExpenseCategory,
      expect.anything(),
    );
    expect(env.manager.save).not.toHaveBeenCalled();
  });

  it('kategoriya faqat qo`lda chiqimda: `finance.cashbox.balance` orqali kirim / boshqa oyoq bilan — 400', async () => {
    const env = makeEnv({
      category: { id: '2', name: "Yoqilg'i", isDeleted: false },
    });
    let error: unknown;
    try {
      await env.service.updateBalance({
        user_id: '0',
        amount: 10_000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.MANUAL_INCOME,
        expense_category_id: '2',
      } as never);
    } catch (e) {
      error = e;
    }
    const payload = (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
    expect(payload.statusCode).toBe(400);
    expect(payload.message).toContain('expense_category_id');
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
