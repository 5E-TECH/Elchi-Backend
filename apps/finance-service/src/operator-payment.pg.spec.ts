import { randomUUID } from 'node:crypto';
import { DataSource, MissingDeleteDateColumnError } from 'typeorm';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('FJVqcUTv - operator tolovi, haqiqiy Postgres', () => {
  const schema = `spec_operator_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
  });

  const expectNoPayment = async () => {
    expect(await db.getRepository(OperatorPayment).count()).toBe(0);
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
    expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(0);
    const cashbox = await db.getRepository(Cashbox).findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });
    expect(cashbox.balance_cash).toBe(10000);
  };

  it('kassa rad etsa tolovi va boshqa yozuvlar qolmaydi', async () => {
    await expect(
      service.createOperatorPayment({ operator_id: '42', amount: 15000 }),
    ).rejects.toBeTruthy();
    await expectNoPayment();
  });

  it('qarzdan ortiq tolov 400 va yozuvsiz', async () => {
    await expect(
      service.createOperatorPayment({ operator_id: '42', amount: 25000 }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expectNoPayment();
  });

  it('P&L yozuvi yiqilsa oldingi ikkita yozuv ham rollback boladi', async () => {
    await db.query(
      `ALTER TABLE "${schema}".financial_balance_history
        ADD CONSTRAINT spec_no_expense CHECK (amount >= 0)`,
    );
    try {
      await expect(
        service.createOperatorPayment({ operator_id: '42', amount: 5000 }),
      ).rejects.toBeTruthy();
      await expectNoPayment();
    } finally {
      await db.query(
        `ALTER TABLE "${schema}".financial_balance_history
          DROP CONSTRAINT spec_no_expense`,
      );
    }
  });

  it('muvaffaqiyatli tolov: tolov qatori, MAIN chiqimi va P&L yozuvi birga commit', async () => {
    const res = await service.createOperatorPayment({
      operator_id: '42',
      amount: 5000,
      paid_by_id: '9',
    });

    expect(res.statusCode).toBe(201);
    expect(await db.getRepository(OperatorPayment).count()).toBe(1);
    const history = await db.getRepository(CashboxHistory).find();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source_type: 'salary',
      operation_type: 'expense',
      source_id: String(res.data.id),
    });
    const ledger = await db.getRepository(FinancialBalanceHistory).find();
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(-5000);
    // ljVOuNz4 — kassa SALARY + daftar SALARY: kategoriya majburiy emas,
    // daftar qatori avtomatik `salary`, kassa qatorida kategoriya yo'q.
    expect(ledger[0].expense_category).toBe('salary');
    expect(history[0].expense_category_id).toBeNull();
    const cashbox = await db.getRepository(Cashbox).findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });
    expect(Number(cashbox.balance_cash)).toBe(5000);
  });

  it('ayni Idempotency-Key bilan ikki marta: bitta tolov, pul bir marta yechiladi', async () => {
    const first = await service.createOperatorPayment({
      operator_id: '42',
      amount: 4000,
      idempotency_key: 'fe-key-1',
    });
    const second = await service.createOperatorPayment({
      operator_id: '42',
      amount: 4000,
      idempotency_key: 'fe-key-1',
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.data).toMatchObject({
      id: first.data.id,
      idempotent: true,
    });
    expect(await db.getRepository(OperatorPayment).count()).toBe(1);
    expect(await db.getRepository(CashboxHistory).count()).toBe(1);
    expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(1);
    const cashbox = await db.getRepository(Cashbox).findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });
    expect(Number(cashbox.balance_cash)).toBe(6000);
  });

  it('parallel ikki tolov operator qarzidan oshmaydi (advisory qulf)', async () => {
    await db
      .getRepository(Cashbox)
      .update(
        { user_id: '0', cashbox_type: Cashbox_type.MAIN },
        { balance: 100000, balance_cash: 100000 },
      );

    const results = await Promise.allSettled([
      service.createOperatorPayment({ operator_id: '42', amount: 15000 }),
      service.createOperatorPayment({ operator_id: '42', amount: 15000 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.getRepository(OperatorPayment).count()).toBe(1);
    const cashbox = await db.getRepository(Cashbox).findOneByOrFail({
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
    });
    expect(Number(cashbox.balance_cash)).toBe(85000);
  });

  it('OperatorPayment softDelete uchun DeleteDateColumn mavjud emas', async () => {
    await expect(
      db.getRepository(OperatorPayment).softDelete({ id: '1' }),
    ).rejects.toBeInstanceOf(MissingDeleteDateColumnError);
  });
});
