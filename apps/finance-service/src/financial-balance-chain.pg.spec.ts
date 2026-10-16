import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Cashbox_type, FinancialSource_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

/**
 * zTYaGWui — P&L daftari (financial_balance_history) zanjiri HAQIQIY
 * Postgres'da. Ilgari yozuvchilar "oxirgi qator"ni `where: {}` bilan
 * (o'chirilganini ham) olardi, o'quvchilar esa `is_deleted = false` bilan —
 * oxirgi qator soft-delete qilinsa zanjir ikkiga bo'linardi.
 *
 * Uchala yozuvchi tekshiriladi: `recordFinancialBalance`,
 * `appendFinancialBalanceInTx` (qo'lda kirim/chiqim) va operator to'lovi.
 * Env (`FINANCE_PG_TEST_URI`) berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('zTYaGWui - P&L daftari zanjiri, haqiqiy Postgres', () => {
  const schema = `spec_fbhchain_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [
        Cashbox,
        CashboxHistory,
        FinancialBalanceHistory,
        OperatorEarning,
        OperatorPayment,
      ],
      synchronize: true,
      // 10 ta parallel yozuvchi + o'quvchi uchun yetarli ulanish.
      extra: { max: 15 },
    });
    await db.initialize();
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      {} as never,
      {} as never,
      db.getRepository(OperatorEarning),
      db.getRepository(OperatorPayment),
      db.getRepository(FinancialBalanceHistory),
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".operator_payments,
        "${schema}".operator_earnings,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
  });

  const record = (amount: number, key: string) =>
    service.recordFinancialBalance({
      amount,
      source_type: FinancialSource_type.MANUAL_INCOME,
      dedup_key: key,
      created_by: '9',
    });

  /** Oxirgi qatorni soft-delete (BaseEntity `is_deleted`). */
  const softDeleteLast = async () => {
    await db.query(
      `UPDATE "${schema}".financial_balance_history SET is_deleted = true
        WHERE id = (SELECT MAX(id) FROM "${schema}".financial_balance_history)`,
    );
  };

  const liveRows = async () =>
    db.getRepository(FinancialBalanceHistory).find({
      where: { isDeleted: false },
      order: { id: 'ASC' },
    });

  /** Invariant: SUM(amount, tirik) == oxirgi TIRIK qatorning balance_after. */
  const invariant = async () => {
    const [row] = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE is_deleted = false), 0)::text AS live_sum,
              (SELECT balance_after::text FROM "${schema}".financial_balance_history
                WHERE is_deleted = false ORDER BY id DESC LIMIT 1) AS last_live_after
         FROM "${schema}".financial_balance_history`,
    );
    return {
      liveSum: Number(row.live_sum),
      lastLiveAfter: Number(row.last_live_after ?? 0),
    };
  };

  /** Ketma-ket tirik qatorlar: prev.after == next.before, after == before + amount. */
  const expectChainIntact = (rows: FinancialBalanceHistory[]) => {
    let prevAfter = 0;
    for (const row of rows) {
      expect(Number(row.balance_before)).toBe(prevAfter);
      expect(Number(row.balance_after)).toBe(
        Number(row.balance_before) + Number(row.amount),
      );
      prevAfter = Number(row.balance_after);
    }
  };

  it('TC1: oxirgi qator o`chirilgach recordFinancialBalance — balance_before = oxirgi TIRIK qatorning balance_after', async () => {
    await record(1000, 'a');
    await record(500, 'b');
    await record(-300, 'c'); // 1200 — keyin o'chiriladi
    await softDeleteLast();

    const res = await record(200, 'd');

    expect(res?.statusCode).toBe(201);
    const created = res?.data as FinancialBalanceHistory;
    expect(Number(created.balance_before)).toBe(1500);
    expect(Number(created.balance_after)).toBe(1700);
    expectChainIntact(await liveRows());
  });

  it('TC1: qo`lda kirim/chiqim yozuvchisi (appendFinancialBalanceInTx) ham tirik qatordan davom etadi', async () => {
    await record(1000, 'a');
    await record(700, 'b');
    await softDeleteLast();

    const saved = await db.transaction((manager) =>
      (
        service as unknown as {
          appendFinancialBalanceInTx: (
            m: typeof manager,
            input: {
              amount: number;
              source_type: FinancialSource_type;
              dedup_key: string;
            },
          ) => Promise<FinancialBalanceHistory>;
        }
      ).appendFinancialBalanceInTx(manager, {
        amount: -250,
        source_type: FinancialSource_type.MANUAL_EXPENSE,
        dedup_key: 'cashbox-history:1',
      }),
    );

    expect(Number(saved.balance_before)).toBe(1000);
    expect(Number(saved.balance_after)).toBe(750);
    expectChainIntact(await liveRows());
  });

  it('TC1: operator to`lovi yozuvchisi ham tirik qatordan davom etadi', async () => {
    await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        balance: 10000,
        balance_cash: 10000,
        balance_card: 0,
      }),
    );
    await db.getRepository(OperatorEarning).save(
      db.getRepository(OperatorEarning).create({
        operator_id: '42',
        order_id: '7001',
        amount: 20000,
      }),
    );
    await record(3000, 'a');
    await record(900, 'b');
    await softDeleteLast();

    const res = await service.createOperatorPayment({
      operator_id: '42',
      amount: 1000,
      paid_by_id: '9',
    });

    expect(res.statusCode).toBe(201);
    const rows = await liveRows();
    expect(rows).toHaveLength(2);
    expect(Number(rows[1].balance_before)).toBe(3000);
    expect(Number(rows[1].balance_after)).toBe(2000);
    expectChainIntact(rows);
  });

  it('TC2: invariant — SUM(amount, is_deleted=false) == oxirgi tirik qatorning balance_after', async () => {
    await record(1000, 'a');
    await record(-400, 'b');
    await record(250, 'c');
    await softDeleteLast();
    await record(80, 'd');
    await record(-30, 'e');
    await softDeleteLast();
    await record(15, 'f');

    const { liveSum, lastLiveAfter } = await invariant();
    expect(liveSum).toBe(695);
    expect(lastLiveAfter).toBe(liveSum);
    expectChainIntact(await liveRows());
  });

  it('TC3: 10 ta parallel recordFinancialBalance — zanjirda uzilish yo`q (advisory lock regressiyasi)', async () => {
    await record(100, 'seed');
    await record(999, 'dead');
    await softDeleteLast();

    const amounts = [10, -20, 30, 40, -50, 60, 70, -80, 90, 100];
    const results = await Promise.all(
      amounts.map((amount, i) => record(amount, `parallel-${i}`)),
    );

    expect(results.every((r) => r?.statusCode === 201)).toBe(true);
    const rows = await liveRows();
    expect(rows).toHaveLength(11);
    expectChainIntact(rows);
    const { liveSum, lastLiveAfter } = await invariant();
    expect(liveSum).toBe(100 + amounts.reduce((s, a) => s + a, 0));
    expect(lastLiveAfter).toBe(liveSum);
  }, 30_000);
});
