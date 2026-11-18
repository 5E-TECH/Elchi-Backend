import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FinancialSource_type, Operation_type, Source_type } from '@app/common';
import { ExpenseCategory } from '@app/common/enums';
import { OperatorPaymentsMarketRecord1716000000241 } from '../../../../migrations/1716000000241-OperatorPaymentsMarketRecord';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { OperatorPayment } from '../entities/operator-payment.entity';
import { tashkentToday } from './operator-payment.service';

/**
 * F2qp6FtE — migratsiya 241 haqiqiy Postgres'da (`FINANCE_PG_TEST_URI`
 * bo'lmasa skip). Migratsiya `finance_schema` ga qattiq bog'langan, shu bois
 * o'z vaqtinchalik BAZASINI yaratadi va oxirida o'chiradi.
 *
 *  • eski qatorlar: `source = 'elchi'`, `affects_cashbox` — ma'lumotdan (kassa
 *    tarixi yoki P&L daftari qatori bor — true, AUDIT M6 dan oldingi — false),
 *    `paid_at` — `createdAt` ning Toshkent sanasi; pul qatorlari o'zgarmaydi;
 *  • eski kod (yangi ustunlarsiz INSERT) — sukutlar eski yo'lni to'g'ri
 *    belgilaydi; CHECK va UNIQUE ishlaydi; entity jadvalga mos;
 *  • qayta yurgizish xatosiz va natija o'zgarmaydi;
 *  • down(): bekor qilingan qator `is_deleted`, ustunlar olinadi; ikki marta
 *    ham xatosiz; keyin up() yana ishlaydi.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('F2qp6FtE migratsiya 241 — haqiqiy Postgres', () => {
  const dbName = `spec_opay_mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new OperatorPaymentsMarketRecord1716000000241();
  const ids: Record<string, string> = {};

  /** TypeORM kabi: bitta tranzaksiyada. */
  const run = async (direction: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const columns = async (): Promise<string[]> =>
    (
      await db.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'finance_schema' AND table_name = 'operator_payments'
          ORDER BY column_name`,
      )
    ).map((row) => row.column_name);

  const rows = async () =>
    await db.query<
      Array<{
        id: string;
        source: string;
        affects_cashbox: boolean;
        paid_at: string;
        amount: string;
        is_deleted: boolean;
      }>
    >(
      `SELECT id::text, source, affects_cashbox, to_char(paid_at, 'YYYY-MM-DD') AS paid_at,
              amount::text, is_deleted
         FROM "finance_schema"."operator_payments" ORDER BY id`,
    );

  const insertLegacy = async (createdAt: string, operatorId = '42') => {
    const [row] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "finance_schema"."operator_payments"
         ("createdAt", "operator_id", "paid_by_id", "amount", "note")
       VALUES ($1, $2, 1, 5000, 'eski') RETURNING id::text`,
      [createdAt, operatorId],
    );
    return row.id;
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const bootstrap = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory],
      synchronize: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA finance_schema');
    await bootstrap.synchronize();
    // `operator_payments` — migratsiya 241 dan OLDINGI shakl (100 + 159).
    await bootstrap.query(`
      CREATE TABLE "finance_schema"."operator_payments" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "operator_id" BIGINT NOT NULL,
        "market_id" BIGINT,
        "paid_by_id" BIGINT,
        "amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
        "note" TEXT
      )`);
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [
        Cashbox,
        CashboxHistory,
        FinancialBalanceHistory,
        OperatorPayment,
      ],
      synchronize: false,
    });
    await db.initialize();

    const cashbox = await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '0',
        cashbox_type: 'main' as never,
        balance: 100000,
        balance_cash: 100000,
        balance_card: 0,
      }),
    );
    const history = (sourceId: string, sourceUserId: string) =>
      db.getRepository(CashboxHistory).save(
        db.getRepository(CashboxHistory).create({
          operation_type: Operation_type.EXPENSE,
          cashbox_id: cashbox.id,
          source_type: Source_type.SALARY,
          source_id: sourceId,
          source_user_id: sourceUserId,
          amount: 5000,
          balance_after: 95000,
        }),
      );
    const ledger = (paymentId: string) =>
      db.getRepository(FinancialBalanceHistory).save(
        db.getRepository(FinancialBalanceHistory).create({
          amount: -5000,
          balance_before: 0,
          balance_after: -5000,
          source_type: FinancialSource_type.SALARY,
          dedup_key: `operator-payment:${paymentId}`,
          related_user_id: '42',
          expense_category: ExpenseCategory.SALARY,
        }),
      );

    // M6 dan keyingi eski to'lov: kassa tarixi + daftar.
    ids.cash = await insertLegacy('2026-10-31T20:30:00Z');
    await history(ids.cash, '42');
    await ledger(ids.cash);
    // Faqat daftar qatori qolgan (masalan tarix qatori keyin o'chirilgan).
    ids.ledgerOnly = await insertLegacy('2026-10-10T08:00:00Z');
    await ledger(ids.ledgerOnly);
    // M6 dan oldingi kassasiz eski yozuv.
    ids.noCash = await insertLegacy('2026-09-01T08:00:00Z');
    // Boshqa xodim maoshi tasodifan ayni source_id bilan — operator to'lovi emas.
    ids.otherSalary = await insertLegacy('2026-09-02T08:00:00Z');
    await history(ids.otherSalary, '777');
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it('up: eski qatorlar ma`lumotdan belgilanadi; pul qatorlari o`zgarmaydi; qayta yurgizish xatosiz', async () => {
    const historyBefore = await db.getRepository(CashboxHistory).count();
    const ledgerBefore = await db
      .getRepository(FinancialBalanceHistory)
      .count();

    await run('up');
    await run('up');

    expect(await columns()).toEqual(
      expect.arrayContaining([
        'source',
        'affects_cashbox',
        'paid_at',
        'recorded_by_role',
        'idempotency_key',
        'cancelled_at',
        'cancelled_by_id',
        'cancelled_by_role',
        'cancel_reason',
      ]),
    );
    const byId = new Map((await rows()).map((row) => [row.id, row]));
    expect(byId.get(ids.cash)).toMatchObject({
      source: 'elchi',
      affects_cashbox: true,
      // 2026-10-31 20:30 UTC = 2026-11-01 01:30 Toshkent.
      paid_at: '2026-11-01',
      amount: '5000.00',
    });
    expect(byId.get(ids.ledgerOnly)).toMatchObject({
      affects_cashbox: true,
      paid_at: '2026-10-10',
    });
    expect(byId.get(ids.noCash)).toMatchObject({
      affects_cashbox: false,
      source: 'elchi',
    });
    expect(byId.get(ids.otherSalary)).toMatchObject({ affects_cashbox: false });
    expect(await db.getRepository(CashboxHistory).count()).toBe(historyBefore);
    expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(
      ledgerBefore,
    );
    const main = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id: '0' });
    expect(Number(main.balance)).toBe(100000);
  });

  it('eski kod INSERT (yangi ustunlarsiz) — eski yo`l sifatida belgilanadi; CHECK va UNIQUE; entity mos', async () => {
    const [legacy] = await db.query<
      Array<{ source: string; affects_cashbox: boolean; paid_at: string }>
    >(
      `INSERT INTO "finance_schema"."operator_payments" ("operator_id", "amount")
       VALUES (42, 100)
       RETURNING source, affects_cashbox, to_char(paid_at, 'YYYY-MM-DD') AS paid_at`,
    );
    expect(legacy).toEqual({
      source: 'elchi',
      affects_cashbox: true,
      paid_at: tashkentToday(),
    });

    await expect(
      db.query(
        `INSERT INTO "finance_schema"."operator_payments"
           ("operator_id", "market_id", "amount", "source", "affects_cashbox")
         VALUES (42, 12, 100, 'market', true)`,
      ),
    ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX/);
    await expect(
      db.query(
        `INSERT INTO "finance_schema"."operator_payments"
           ("operator_id", "market_id", "amount", "source", "affects_cashbox")
         VALUES (42, NULL, 100, 'market', false)`,
      ),
    ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_MARKET_NO_CASHBOX/);
    await expect(
      db.query(
        `UPDATE "finance_schema"."operator_payments"
            SET "cancelled_at" = now(), "cancel_reason" = 'x' WHERE id = $1`,
        [ids.cash],
      ),
    ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_CANCEL/);

    const repo = db.getRepository(OperatorPayment);
    const saved = await repo.save(
      repo.create({
        operator_id: '42',
        market_id: '12',
        paid_by_id: '12',
        recorded_by_role: 'market',
        amount: 1500.5,
        paid_at: '2026-11-17',
        note: null,
        source: 'market',
        affects_cashbox: false,
        idempotency_key: 'k-1',
      }),
    );
    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded).toMatchObject({
      paid_at: '2026-11-17',
      amount: 1500.5,
      source: 'market',
    });
    await expect(
      repo.save(
        repo.create({
          operator_id: '43',
          market_id: '12',
          amount: 10,
          source: 'market',
          affects_cashbox: false,
          idempotency_key: 'k-1',
        }),
      ),
    ).rejects.toThrow(/UQ_OPERATOR_PAYMENT_IDEMPOTENCY/);
    // Bekor qilish — faqat sabab bilan.
    await expect(
      repo.update(
        { id: saved.id },
        { cancelled_at: new Date(), cancel_reason: '  ' },
      ),
    ).rejects.toThrow(/CHK_OPERATOR_PAYMENT_CANCEL/);
    await repo.update(
      { id: saved.id },
      { cancelled_at: new Date(), cancel_reason: 'Xato summa' },
    );
    ids.cancelled = String(saved.id);
  });

  it('down: bekor qilingan qator is_deleted, ustunlar olinadi; ikki marta ham; up yana ishlaydi', async () => {
    await run('down');
    await run('down');

    expect(await columns()).not.toEqual(expect.arrayContaining(['source']));
    const [cancelled] = await db.query<Array<{ is_deleted: boolean }>>(
      `SELECT is_deleted FROM "finance_schema"."operator_payments" WHERE id = $1`,
      [ids.cancelled],
    );
    expect(cancelled.is_deleted).toBe(true);
    const [legacy] = await db.query<Array<{ is_deleted: boolean }>>(
      `SELECT is_deleted FROM "finance_schema"."operator_payments" WHERE id = $1`,
      [ids.cash],
    );
    expect(legacy.is_deleted).toBe(false);

    await run('up');
    expect(await columns()).toEqual(
      expect.arrayContaining(['source', 'paid_at']),
    );
  });
});
