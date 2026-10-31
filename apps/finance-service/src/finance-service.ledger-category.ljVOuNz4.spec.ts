import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FinancialSource_type, Source_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxExpenseCategory } from './entities/cashbox-expense-category.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';

/**
 * ljVOuNz4 (B) — P&L daftaridagi kategoriya (HAQIQIY `recordFinancialBalance`
 * va `spendMoney`, tranzaksiya mock). Majburiylik gateway'da; bu yerda ichki
 * chaqiruvchilar kategoriyasiz o'tadi, qiymat esa manba qoidasiga bo'ysunadi.
 */
type Row = Record<string, unknown>;

function makeEnv(options: { existing?: Row; category?: Row | null } = {}) {
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
    findOne: jest.fn((entity: unknown, query?: { where?: Row }) => {
      if (entity === CashboxExpenseCategory) {
        return Promise.resolve(options.category ?? null);
      }
      if (entity === FinancialBalanceHistory) {
        // Idempotentlik so'rovi (`dedup_key` bilan) yoki oxirgi qator.
        return Promise.resolve(
          query?.where && 'dedup_key' in query.where
            ? (options.existing ?? null)
            : { id: '55', balance_after: 5_000_000 },
        );
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
    query: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const historyRepo = {
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    count: jest.fn().mockResolvedValue(0),
  };
  const financialHistoryRepo = {
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const service = new FinanceServiceService(
    {} as never,
    historyRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    financialHistoryRepo as never,
    { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    { send: jest.fn(() => of({ statusCode: 200 })) } as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
  );
  jest
    .spyOn(service as any, 'getCashboxBySelectorWithManager')
    .mockResolvedValue(main);
  const ledgerCreates = () =>
    manager.create.mock.calls
      .filter(([entity]) => entity === FinancialBalanceHistory)
      .map(([, dto]) => dto);
  return {
    service,
    queryRunner,
    historyRepo,
    financialHistoryRepo,
    ledgerCreates,
  };
}

const entry = (extra: Row) => ({
  amount: -50_000,
  dedup_key: 'manual-entry:9:k',
  created_by: '9',
  comment: 'Izoh',
  ...extra,
});

const rpcStatus = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode: number;
    message: string;
  };
};

describe('ljVOuNz4 — recordFinancialBalance: kategoriya', () => {
  it('manual_expense: tanlangan kategoriya qatorga yoziladi', async () => {
    const env = makeEnv();
    await env.service.recordFinancialBalance(
      entry({
        source_type: FinancialSource_type.MANUAL_EXPENSE,
        expense_category: 'fuel',
      }) as never,
    );
    expect(env.ledgerCreates()[0]).toMatchObject({
      expense_category: 'fuel',
      comment: 'Izoh',
    });
  });

  it('⭐ salary: kategoriya so`ralmaydi, qator avtomatik `salary`', async () => {
    const env = makeEnv();
    await env.service.recordFinancialBalance(
      entry({ source_type: FinancialSource_type.SALARY }) as never,
    );
    expect(env.ledgerCreates()[0]).toMatchObject({
      expense_category: 'salary',
    });
  });

  it('salary: yuborilgan boshqa qiymat ham `salary` bo`ladi', async () => {
    const env = makeEnv();
    await env.service.recordFinancialBalance(
      entry({
        source_type: FinancialSource_type.SALARY,
        expense_category: 'fuel',
      }) as never,
    );
    expect(env.ledgerCreates()[0]).toMatchObject({
      expense_category: 'salary',
    });
  });

  it.each([
    FinancialSource_type.CORRECTION,
    FinancialSource_type.MANUAL_INCOME,
  ])('⭐ %s: ustun NULL qoladi (yuborilsa ham)', async (source_type) => {
    const env = makeEnv();
    await env.service.recordFinancialBalance(
      entry({ source_type, amount: 1000, expense_category: 'fuel' }) as never,
    );
    expect(env.ledgerCreates()[0]).toMatchObject({ expense_category: null });
  });

  it('⭐ ichki chaqiruvchi (investor, sotuv) kategoriyasiz o`tadi — NULL', async () => {
    const env = makeEnv();
    const res = await env.service.recordFinancialBalance(
      entry({ source_type: FinancialSource_type.MANUAL_EXPENSE }) as never,
    );
    expect(res?.statusCode).toBe(201);
    expect(env.ledgerCreates()[0]).toMatchObject({ expense_category: null });
  });

  it('RMQ orqali noto`g`ri qiymat — Postgres 500 emas, 400', async () => {
    const env = makeEnv();
    const error = await rpcStatus(
      env.service.recordFinancialBalance(
        entry({
          source_type: FinancialSource_type.MANUAL_EXPENSE,
          expense_category: 'foo',
        }) as never,
      ),
    );
    expect(error.statusCode).toBe(400);
    expect(env.ledgerCreates()).toEqual([]);
  });

  it('bills: cheklovdan tashqari qiymat — 400', async () => {
    const env = makeEnv();
    const error = await rpcStatus(
      env.service.recordFinancialBalance(
        entry({
          source_type: FinancialSource_type.BILLS,
          expense_category: 'fuel',
        }) as never,
      ),
    );
    expect(error.statusCode).toBe(400);
  });

  it('ayni kalit boshqa kategoriya bilan — 409 (idempotentlik)', async () => {
    const env = makeEnv({
      existing: {
        id: '7',
        amount: -50_000,
        created_by: '9',
        related_user_id: null,
        comment: 'Izoh',
        expense_category: 'rent',
      },
    });
    const error = await rpcStatus(
      env.service.recordFinancialBalance(
        entry({
          source_type: FinancialSource_type.MANUAL_EXPENSE,
          expense_category: 'fuel',
        }) as never,
      ),
    );
    expect(error.statusCode).toBe(409);
  });

  it('ayni kalit ayni kategoriya bilan — mavjud yozuv', async () => {
    const env = makeEnv({
      existing: {
        id: '7',
        amount: -50_000,
        created_by: '9',
        related_user_id: null,
        comment: 'Izoh',
        expense_category: 'fuel',
      },
    });
    const res = await env.service.recordFinancialBalance(
      entry({
        source_type: FinancialSource_type.MANUAL_EXPENSE,
        expense_category: 'fuel',
      }) as never,
    );
    expect(res?.statusCode).toBe(200);
    expect(env.ledgerCreates()).toEqual([]);
  });
});

describe('ljVOuNz4 — qo`lda kassa chiqimining daftar qatori', () => {
  const spend = {
    user_id: '9',
    amount: 150_000,
    comment: 'Benzin',
    created_by: '9',
    dedup_epoch: 'idem-1',
    financial_ledger: true,
    expense_category_id: '2',
  };

  it('⭐ kassa kategoriyasining `ledger_category` si daftar qatoriga o`tadi', async () => {
    const env = makeEnv({
      category: { id: '2', name: "Yoqilg'i", ledger_category: 'fuel' },
    });
    await env.service.spendMoney(spend);
    expect(env.ledgerCreates()).toHaveLength(1);
    expect(env.ledgerCreates()[0]).toMatchObject({
      source_type: FinancialSource_type.MANUAL_EXPENSE,
      expense_category: 'fuel',
      comment: 'Benzin',
    });
  });

  it('superadmin qo`shgan (bog`lanmagan) kategoriya — `other`, NULL emas', async () => {
    const env = makeEnv({
      category: { id: '30', name: 'Mehmonxona', ledger_category: null },
    });
    await env.service.spendMoney(spend);
    expect(env.ledgerCreates()[0]).toMatchObject({ expense_category: 'other' });
  });

  it('kirim daftar qatorida kategoriya yo`q', async () => {
    const env = makeEnv();
    await env.service.fillTheCashbox({
      user_id: '9',
      amount: 1000,
      created_by: '9',
      dedup_epoch: 'idem-2',
      financial_ledger: true,
    });
    expect(env.ledgerCreates()[0]).toMatchObject({ expense_category: null });
  });
});

describe('ljVOuNz4 — ro`yxat filtrlari', () => {
  const where = (mock: jest.Mock) =>
    (mock.mock.calls[0] as [{ where: Row }])[0].where;

  it('daftar: `expense_category=fuel`', async () => {
    const env = makeEnv();
    await env.service.findFinancialBalanceHistory({
      expense_category: 'fuel',
    });
    expect(where(env.financialHistoryRepo.findAndCount)).toMatchObject({
      expense_category: 'fuel',
    });
  });

  it('daftar: `none` — kategoriyasiz qo`lda chiqim / bills', async () => {
    const env = makeEnv();
    await env.service.findFinancialBalanceHistory({
      expense_category: 'none',
    });
    const filter = where(env.financialHistoryRepo.findAndCount) as {
      expense_category: { _type: string };
      source_type: { _value: string[] };
    };
    expect(filter.expense_category._type).toBe('isNull');
    expect(filter.source_type._value).toEqual(['manual_expense', 'bills']);
  });

  it('daftar: noto`g`ri qiymat — 400', async () => {
    const env = makeEnv();
    const error = await rpcStatus(
      env.service.findFinancialBalanceHistory({ expense_category: 'foo' }),
    );
    expect(error.statusCode).toBe(400);
  });

  it('kassa: `expense_category_id=5`', async () => {
    const env = makeEnv();
    await env.service.findAllHistory({ expense_category_id: '5' });
    expect(where(env.historyRepo.findAndCount)).toMatchObject({
      expense_category_id: '5',
    });
  });

  it('kassa: `none` — kategoriyasiz qo`lda chiqim', async () => {
    const env = makeEnv();
    await env.service.findAllHistory({ expense_category_id: 'none' });
    const filter = where(env.historyRepo.findAndCount) as {
      expense_category_id: { _type: string };
      source_type: string;
    };
    expect(filter.expense_category_id._type).toBe('isNull');
    expect(filter.source_type).toBe(Source_type.MANUAL_EXPENSE);
  });

  it('kassa: noto`g`ri qiymat — 400', async () => {
    const env = makeEnv();
    const error = await rpcStatus(
      env.service.findAllHistory({ expense_category_id: 'abc' }),
    );
    expect(error.statusCode).toBe(400);
  });
});

// Sinf importi tree-shake qilinmasin (mock `create` entity solishtiradi).
void CashboxHistory;
