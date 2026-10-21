import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type } from '@app/common';
import {
  CASHBOX_EXPENSE_CATEGORY_SEED,
  CreateCashboxExpenseCategories1716000000129,
} from '../../../../migrations/1716000000129-CreateCashboxExpenseCategories';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift } from '../entities/shift.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { ExpenseCategoryService } from './expense-category.service';

/**
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari, HAQIQIY Postgres.
 * Alohida vaqtinchalik BAZA (migratsiya `finance_schema` ni qattiq yozadi):
 * asosiy jadvallar entity sinxronizatsiyasi bilan, kategoriya jadvali va
 * `cashbox_history.expense_category_*` ustunlari esa FAQAT migratsiya 129
 * bilan (entity ↔ migratsiya mosligi tekshiriladi).
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('Elchi Pochta №1 — xarajat kategoriyalari, haqiqiy Postgres', () => {
  const dbName = `spec_expcat_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let categories: ExpenseCategoryService;
  let finance: FinanceServiceService;
  const migration = new CreateCashboxExpenseCategories1716000000129();
  const ORIGINAL_ENV = process.env.FINANCE_REQUIRE_OPEN_SHIFT;

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    // 1) Mavjud jadvallar — entity'dan; yangi ustunlar olib tashlanadi
    //    (prod'dagi holat: migratsiya 129 dan oldin ular yo'q).
    const base = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, Shift, FinancialBalanceHistory],
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
    await base.destroy();

    // 2) Kategoriyalar — FAQAT migratsiya bilan.
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
      ],
      synchronize: false,
      extra: { max: 10 },
    });
    await db.initialize();
    const runner = db.createQueryRunner();
    await migration.up(runner);
    await runner.release();

    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    categories = new ExpenseCategoryService(db, activityLog as never);
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      { send: jest.fn(() => of({ statusCode: 200 })) } as never,
      { send: jest.fn() } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: null })) } as never,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    } else {
      process.env.FINANCE_REQUIRE_OPEN_SHIFT = ORIGINAL_ENV;
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const cashboxRepo = () => db.getRepository(Cashbox);
  const main = () =>
    cashboxRepo().findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });
  const seededNames = () => CASHBOX_EXPENSE_CATEGORY_SEED.map((c) => c.name);
  const activeRows = async () =>
    (await db.query(
      `SELECT "id"::text AS id, "name", "description", "sort_order"
         FROM "finance_schema"."cashbox_expense_categories"
        WHERE "is_deleted" = false
        ORDER BY "sort_order", "id"`,
    )) as Array<{
      id: string;
      name: string;
      description: string | null;
      sort_order: number;
    }>;
  const idOf = async (name: string) =>
    (await activeRows()).find((row) => row.name === name)!.id;

  /** Har test — toza kassa + seed holatidagi kategoriyalar. */
  const resetCategories = async () => {
    const runner = db.createQueryRunner();
    try {
      await migration.down(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  };

  beforeEach(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    await resetCategories();
    await db.query(
      `TRUNCATE TABLE "finance_schema"."cashbox_history",
        "finance_schema"."financial_balance_history",
        "finance_schema"."shifts", "finance_schema"."cashboxes"
        RESTART IDENTITY CASCADE`,
    );
    await cashboxRepo().save(
      cashboxRepo().create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 600_000,
        balance_cash: 500_000,
        balance_card: 100_000,
      }),
    );
  });

  it('⭐ migratsiya 129: 17 ta kategoriya PO tartibida (sort_order 1..17), indekslar, tarix ustunlari; qayta up() dublikat yozmaydi; down() → up()', async () => {
    const rows = await activeRows();
    expect(rows.map((r) => r.name)).toEqual(seededNames());
    expect(rows.map((r) => r.sort_order)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
    expect(rows.find((r) => r.name === "Yoqilg'i")?.description).toBe(
      'Benzin, gaz, dizel',
    );

    const cols = async (table: string) =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'finance_schema' AND table_name = $1`,
          [table],
        )
      ).map((r: { column_name: string }) => r.column_name);
    expect(await cols('cashbox_history')).toEqual(
      expect.arrayContaining(['expense_category_id', 'expense_category_name']),
    );
    const indexes = (
      await db.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'finance_schema'`,
      )
    ).map((r: { indexname: string }) => r.indexname);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'UQ_CASHBOX_EXPENSE_CATEGORY_NAME',
        'IDX_CASHBOX_HISTORY_EXPENSE_CATEGORY',
      ]),
    );

    // Idempotent: ikkinchi up() yangi qator yozmaydi.
    const runner = db.createQueryRunner();
    try {
      await migration.up(runner);
      expect(await activeRows()).toHaveLength(17);

      await migration.down(runner);
      expect(await cols('cashbox_expense_categories')).toEqual([]);
      expect(await cols('cashbox_history')).not.toContain(
        'expense_category_id',
      );
    } finally {
      await migration.up(runner);
      await runner.release();
    }
    expect((await activeRows()).map((r) => r.name)).toEqual(seededNames());
  });

  it('noyob nom (katta-kichik harf farqsiz, o`chirilmaganlar orasida): servis 409, baza 23505; o`chirilgan nom qayta beriladi', async () => {
    const dup: any = await categories
      .create({ name: "YOQILG'I", created_by: '1' })
      .catch((e: { getError: () => unknown }) => e.getError());
    expect(dup).toMatchObject({ statusCode: 409 });
    await expect(
      db.query(
        `INSERT INTO "finance_schema"."cashbox_expense_categories" ("name")
         VALUES ('ovqatlanish')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const fuelId = await idOf("Yoqilg'i");
    await categories.remove({ id: fuelId, deleted_by: '1' });
    const again: any = await categories.create({
      name: "Yoqilg'i",
      created_by: '1',
    });
    expect(again.statusCode).toBe(201);
    expect(again.data.category).toMatchObject({
      name: "Yoqilg'i",
      sort_order: 18,
      created_by: '1',
    });
    expect(again.data.category.id).not.toBe(fuelId);

    // Ro'yxat: o'chirilgan sukut bo'yicha yo'q, include_deleted — oxirida.
    const list: any = await categories.list();
    expect(list.data.items).toHaveLength(17);
    expect(list.data.items.at(-1).name).toBe("Yoqilg'i");
    const withDeleted: any = await categories.list({ include_deleted: true });
    expect(withDeleted.data.items).toHaveLength(18);
    expect(withDeleted.data.items.at(-1)).toMatchObject({
      id: fuelId,
      is_deleted: true,
      updated_by: '1',
    });
  });

  it('⭐ chiqim kategoriya bilan → tarixda id + nom; kategoriya qayta nomlansa / o`chirilsa ham tarix nomni saqlaydi; o`chirilganga chiqim — 400, kassa o`zgarmaydi', async () => {
    const fuelId = await idOf("Yoqilg'i");
    const spent: any = await finance.spendMoney({
      user_id: '1',
      amount: 50_000,
      comment: 'Benzin',
      created_by: '1',
      dedup_epoch: 'pg-spend-1',
      expense_category_id: fuelId,
      financial_ledger: true,
    });
    expect(spent.data.history).toMatchObject({
      expense_category_id: fuelId,
      expense_category_name: "Yoqilg'i",
    });
    expect((await main()).balance_cash).toBe(450_000);

    await categories.update({ id: fuelId, name: 'Benzin', updated_by: '1' });
    await categories.remove({ id: fuelId, deleted_by: '1' });

    // Tarix ro'yxati va tafsiloti — snapshot nom.
    const history: any = await finance.findAllHistory({
      cashbox_type: Cashbox_type.MAIN,
    } as never);
    expect(history.data.items).toHaveLength(1);
    expect(history.data.items[0]).toMatchObject({
      expense_category_id: fuelId,
      expense_category_name: "Yoqilg'i",
    });
    const detail: any = await finance.findHistoryById(
      String(spent.data.history.id),
    );
    expect(detail.data).toMatchObject({
      expense_category_id: fuelId,
      expense_category_name: "Yoqilg'i",
    });
    const mainPage: any = await finance.getMainCashbox();
    expect(mainPage.data.cashboxHistory[0]).toMatchObject({
      expense_category_name: "Yoqilg'i",
    });

    // O'chirilgan kategoriyaga yangi chiqim — 400, hech narsa yozilmaydi.
    const rejected: any = await finance
      .spendMoney({
        user_id: '1',
        amount: 10_000,
        dedup_epoch: 'pg-spend-2',
        expense_category_id: fuelId,
        financial_ledger: true,
      })
      .catch((e: { getError: () => unknown }) => e.getError());
    expect(rejected).toMatchObject({ statusCode: 400 });
    expect((await main()).balance_cash).toBe(450_000);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM "finance_schema"."cashbox_history"`,
    );
    expect(count).toBe(1);

    // Kategoriyasiz chiqim — avvalgidek, NULL.
    const plain: any = await finance.spendMoney({
      user_id: '1',
      amount: 10_000,
      dedup_epoch: 'pg-spend-3',
      financial_ledger: true,
    });
    expect(plain.data.history).toMatchObject({
      expense_category_id: null,
      expense_category_name: null,
    });
    expect((await main()).balance_cash).toBe(440_000);
  });
});
