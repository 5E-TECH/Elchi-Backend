import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import {
  Cashbox_type,
  ExpenseCategory,
  FinancialSource_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { CreateCashboxExpenseCategories1716000000129 } from '../../../../migrations/1716000000129-CreateCashboxExpenseCategories';
import {
  FinancialExpenseCategory1716000000197,
  SEED_LEDGER_CATEGORY_BY_NAME,
} from '../../../../migrations/1716000000197-FinancialExpenseCategory';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift } from '../entities/shift.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { OperatorEarning } from '../entities/operator-earning.entity';
import { OperatorPayment } from '../entities/operator-payment.entity';

type Report = {
  total_amount: number;
  transaction_count: number;
  categories: Array<{
    category: string;
    total_amount: number;
    transaction_count: number;
  }>;
  uncategorized: { total_amount: number; transaction_count: number };
};

/**
 * ljVOuNz4 — daftar kategoriyasi va xarajat hisoboti, HAQIQIY Postgres.
 * Migratsiya 197 prod holatida (ustunlarsiz, eski qatorlar bilan) yuritiladi:
 * eski qatorlar NULL, `down()` xatosiz, qayta `up()` xavfsiz.
 *
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('ljVOuNz4 — daftar kategoriyasi, haqiqiy Postgres', () => {
  const dbName = `spec_expreport_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  const migration = new FinancialExpenseCategory1716000000197();
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  beforeAll(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    // Prod holati: migratsiya 197 dan oldin ustunlar va enum turi yo'q.
    const base = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        FinancialBalanceHistory,
        OperatorEarning,
        OperatorPayment,
      ],
      synchronize: false,
    });
    await base.initialize();
    await base.query('CREATE SCHEMA IF NOT EXISTS "finance_schema"');
    await base.synchronize();
    await base.query(
      `ALTER TABLE "finance_schema"."cashbox_history"
         DROP COLUMN "expense_category_id",
         DROP COLUMN "expense_category_name"`,
    );
    await base.query(`DROP INDEX "finance_schema"."IDX_FBH_EXPENSE_CATEGORY"`);
    await base.query(
      `ALTER TABLE "finance_schema"."financial_balance_history"
         DROP COLUMN "expense_category"`,
    );
    await base.query(`DROP TYPE "finance_schema"."expense_category_enum"`);
    await base.destroy();

    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        Shift,
        FinancialBalanceHistory,
        CashboxExpenseCategory,
        OperatorEarning,
        OperatorPayment,
      ],
      synchronize: false,
      extra: { max: 10 },
    });
    await db.initialize();
    const runner = db.createQueryRunner();
    await new CreateCashboxExpenseCategories1716000000129().up(runner);
    await runner.release();

    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      db.getRepository(OperatorEarning),
      db.getRepository(OperatorPayment),
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: null })) } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const ledgerRow = (
    amount: number,
    source: FinancialSource_type,
    dedup_key: string,
  ) =>
    db.query<Array<{ id: string }>>(
      `INSERT INTO "finance_schema"."financial_balance_history"
         ("amount", "balance_before", "balance_after", "source_type", "dedup_key")
       VALUES ($1, 0, 0, $2, $3) RETURNING "id"`,
      [amount, source, dedup_key],
    );

  const historyRow = async (input: {
    cashbox_id: string;
    amount: number;
    source_type: Source_type;
    operation_type?: Operation_type;
    source_id?: string;
    dedup_epoch?: string;
  }) => {
    const repo = db.getRepository(CashboxHistory);
    return repo.save(
      repo.create({
        cashbox_id: input.cashbox_id,
        amount: input.amount,
        balance_after: 0,
        source_type: input.source_type,
        operation_type: input.operation_type ?? Operation_type.EXPENSE,
        source_id: input.source_id ?? null,
        dedup_epoch: input.dedup_epoch ?? '',
        payment_method: PaymentMethod.CASH,
      }),
    );
  };

  const report = async (input: { from_date?: string; to_date?: string } = {}) =>
    (
      (await finance.financialBalanceExpenseReport(input)) as {
        data: Report;
      }
    ).data;

  const rowFor = (data: Report, category: string) =>
    data.categories.find((row) => row.category === category);

  it('migratsiya: eski qatorlar NULL, seed bog`lanadi, down va qayta up xatosiz', async () => {
    await ledgerRow(-1000, FinancialSource_type.MANUAL_EXPENSE, 'old-1');
    await ledgerRow(5000, FinancialSource_type.SELL_PROFIT, 'old-2');

    const runner = db.createQueryRunner();
    await migration.up(runner);
    await migration.down(runner);
    const columns = await db.query<unknown[]>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'finance_schema'
          AND column_name IN ('expense_category', 'ledger_category')`,
    );
    expect(columns).toEqual([]);
    await migration.up(runner);
    await migration.up(runner); // idempotent
    await runner.release();

    const old = await db.query<
      Array<{ expense_category: string | null; dedup_key: string }>
    >(
      `SELECT "expense_category", "dedup_key" FROM "finance_schema"."financial_balance_history" ORDER BY "id"`,
    );
    expect(old).toEqual([
      { expense_category: null, dedup_key: 'old-1' },
      { expense_category: null, dedup_key: 'old-2' },
    ]);

    const seeded = await db.query<
      Array<{ name: string; ledger_category: string | null }>
    >(
      `SELECT "name", "ledger_category" FROM "finance_schema"."cashbox_expense_categories"`,
    );
    expect(seeded).toHaveLength(17);
    for (const row of seeded) {
      expect(row.ledger_category).toBe(
        SEED_LEDGER_CATEGORY_BY_NAME[row.name] ?? null,
      );
    }
    expect(seeded.find((row) => row.name === "Yoqilg'i")?.ledger_category).toBe(
      'fuel',
    );
    await db.query(
      `TRUNCATE "finance_schema"."financial_balance_history" RESTART IDENTITY`,
    );
  });

  it('⭐ hisobot: ko`chirish kirmaydi, qo`shaloq yozuv bir marta, NULL ayrim, jamlar teng', async () => {
    const main = await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 100_000_000,
        balance_cash: 100_000_000,
        balance_card: 0,
      }),
    );
    const courier = await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '77',
        cashbox_type: Cashbox_type.FOR_COURIER,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      }),
    );

    // 1) Haqiqiy kassa chiqimi (kassa + daftar, bitta tranzaksiya): bir marta.
    const [fuel] = await db.query<Array<{ id: string }>>(
      `SELECT "id" FROM "finance_schema"."cashbox_expense_categories" WHERE "name" = $1`,
      ["Yoqilg'i"],
    );
    await finance.spendMoney({
      user_id: '9',
      amount: 150_000.25,
      comment: 'AI-92',
      created_by: '9',
      dedup_epoch: 'spend-1',
      financial_ledger: true,
      expense_category_id: String(fuel.id),
    });
    const [savedLedger] = await db
      .getRepository(FinancialBalanceHistory)
      .find({ where: { source_type: FinancialSource_type.MANUAL_EXPENSE } });
    expect(savedLedger.expense_category).toBe(ExpenseCategory.FUEL);
    expect(savedLedger.comment).toBe('AI-92');
    // (A) Kassa qatorida kategoriya + izoh, balans aniq kamaygan.
    const [spent] = await db.getRepository(CashboxHistory).find({
      where: { dedup_epoch: 'spend-1' },
    });
    expect(spent.comment).toBe('AI-92');
    expect(spent.expense_category_name).toBe("Yoqilg'i");
    const after = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ id: main.id });
    expect(Number(after.balance)).toBe(100_000_000 - 150_000.25);

    // 1b) Migratsiya 197 dan oldingi chiqim: kassada kategoriya bor, daftar
    //     qatori NULL — ustun yozilmaydi, hisobot kassa juftidan oladi.
    const before197 = await historyRow({
      cashbox_id: main.id,
      amount: 60_000,
      source_type: Source_type.MANUAL_EXPENSE,
    });
    await db.query(
      `UPDATE "finance_schema"."cashbox_history"
          SET "expense_category_id" = $1, "expense_category_name" = 'Yoqilg''i'
        WHERE "id" = $2`,
      [fuel.id, before197.id],
    );
    await ledgerRow(
      -60_000,
      FinancialSource_type.MANUAL_EXPENSE,
      `cashbox-history:${String(before197.id)}`,
    );

    // 2) Daftarga qo'lda chiqim.
    await finance.recordFinancialBalance({
      amount: -2_000_000,
      source_type: FinancialSource_type.BILLS,
      expense_category: ExpenseCategory.UTILITIES,
      dedup_key: 'manual-entry:9:a',
      created_by: '9',
    });

    // 3) Operator to'lovi kabi juftlik: kassa SALARY + daftar SALARY (eski, NULL).
    await historyRow({
      cashbox_id: main.id,
      amount: 300_000,
      source_type: Source_type.SALARY,
      source_id: '501',
    });
    await ledgerRow(
      -300_000,
      FinancialSource_type.SALARY,
      'operator-payment:501',
    );

    // 4) Investor to'lovi: kassa (`dedup_epoch`) + daftar — kategoriyasiz.
    await historyRow({
      cashbox_id: main.id,
      amount: 70_000,
      source_type: Source_type.MANUAL_EXPENSE,
      dedup_epoch: 'investor-profit:3',
    });
    await ledgerRow(
      -70_000,
      FinancialSource_type.MANUAL_EXPENSE,
      'investor-profit:3',
    );

    // 5) Daftarga tushmagan eski kassa chiqimi (IgR4FVsR dan oldin) — NULL.
    await historyRow({
      cashbox_id: main.id,
      amount: 40_000,
      source_type: Source_type.MANUAL_EXPENSE,
    });

    // 6) Ko'chirishlar — hisobotga KIRMAYDI.
    for (const source_type of [
      Source_type.COURIER_PAYMENT,
      Source_type.MARKET_PAYMENT,
      Source_type.BRANCH_TO_MAIN,
    ]) {
      await historyRow({ cashbox_id: main.id, amount: 9_000_000, source_type });
    }

    // 7) Kuryer kassasidagi extra_cost oyog'i — daftardagi sell_extra_cost bilan
    //    bir marta; qaytarilgani (rollback) jamdan ayriladi.
    await historyRow({
      cashbox_id: courier.id,
      amount: 25_000,
      source_type: Source_type.EXTRA_COST,
      source_id: '901',
    });
    await db.query(
      `INSERT INTO "finance_schema"."financial_balance_history"
         ("amount", "balance_before", "balance_after", "source_type", "dedup_key", "order_id")
       VALUES (-25000, 0, 0, 'sell_extra_cost', 'sale:1', 901),
              (-15000, 0, 0, 'cancel_extra_cost', 'cancel:1', 902),
              (15000, 0, 0, 'correction', 'rollback-extra:1', 902)`,
    );

    // 8) Tuzatish va foyda — xarajat emas.
    await ledgerRow(
      -11_000,
      FinancialSource_type.CORRECTION,
      'manual-entry:9:c',
    );
    await ledgerRow(800_000, FinancialSource_type.SELL_PROFIT, 'profit');

    // 9) O'chirilgan qator — kirmaydi.
    await db.query(
      `INSERT INTO "finance_schema"."financial_balance_history"
         ("amount", "balance_before", "balance_after", "source_type", "dedup_key", "is_deleted")
       VALUES (-999999, 0, 0, 'manual_expense', 'deleted', true)`,
    );

    const data = await report();

    expect(rowFor(data, 'fuel')).toMatchObject({
      total_amount: 210_000.25,
      transaction_count: 2,
    });
    expect(rowFor(data, 'utilities')?.total_amount).toBe(2_000_000);
    expect(rowFor(data, 'salary')).toMatchObject({
      total_amount: 300_000,
      transaction_count: 1,
    });
    expect(rowFor(data, 'courier_fee')?.total_amount).toBe(25_000);
    // Investor (daftar) + eski kassa chiqimi — «Boshqa» emas.
    expect(rowFor(data, 'other')).toBeUndefined();
    expect(data.uncategorized).toMatchObject({
      total_amount: 110_000,
      transaction_count: 2,
    });

    const sum =
      data.categories.reduce((acc, row) => acc + row.total_amount, 0) +
      data.uncategorized.total_amount;
    expect(Math.round(sum * 100) / 100).toBe(data.total_amount);
    expect(data.total_amount).toBe(2_645_000.25);
  });

  it('sana filtri: davrdan tashqari qator kirmaydi', async () => {
    const data = await report({
      from_date: '2020-01-01',
      to_date: '2020-01-02',
    });
    expect(data.total_amount).toBe(0);
    expect(data.categories).toEqual([]);
  });

  it('filtrlar haqiqiy Postgres`da: daftar `none`/`fuel`, kassa `none`/id', async () => {
    const list = async (expense_category: string) =>
      (
        (await finance.findFinancialBalanceHistory({ expense_category })) as {
          data: { rows: FinancialBalanceHistory[] };
        }
      ).data.rows;

    expect((await list('fuel')).map((row) => row.comment)).toEqual(['AI-92']);
    const none = await list('none');
    expect(none.map((row) => row.dedup_key)).toContain('investor-profit:3');
    expect(none.every((row) => row.source_type === 'manual_expense')).toBe(
      true,
    );

    const [fuel] = await db.query<Array<{ id: string }>>(
      `SELECT "id" FROM "finance_schema"."cashbox_expense_categories" WHERE "name" = $1`,
      ["Yoqilg'i"],
    );
    const history = async (expense_category_id: string) =>
      (
        (await finance.findAllHistory({ expense_category_id })) as {
          data: { items: CashboxHistory[] };
        }
      ).data.items;
    expect(
      (await history(String(fuel.id))).map((row) => row.comment),
    ).toContain('AI-92');
    expect(
      (await history('none')).map((row) => Number(row.amount)).sort(),
    ).toEqual([40_000, 70_000]);
  });
});
