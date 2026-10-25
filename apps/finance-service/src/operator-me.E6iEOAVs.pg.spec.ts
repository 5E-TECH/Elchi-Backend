import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

/**
 * E6iEOAVs — `finance/operators/me/*` qayta ishlatadigan RMQ handler'lari
 * (gateway operator_id ni JWT'dan beradi) HAQIQIY Postgres'da:
 *  - operator FAQAT o'z yozuvlarini ko'radi (boshqa operator va o'chirilgan
 *    yozuvlar chiqmaydi);
 *  - komissiyasi belgilanmagan (yozuvi yo'q) operator — 0/0/0 va bo'sh
 *    ro'yxat, 403/404 emas (maket earnings-no-commission).
 * Env (`FINANCE_OPERATOR_PG_TEST_URI` / `FINANCE_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('E6iEOAVs — operator o`z daromadi (Postgres)', () => {
  const schema = `spec_opme_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
      extra: { max: 3 },
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

    const earnings = db.getRepository(OperatorEarning);
    const payments = db.getRepository(OperatorPayment);
    await earnings.save([
      earnings.create({
        operator_id: '77',
        order_id: '9001',
        market_id: '37',
        amount: 5_000,
        order_total_price: 100_000,
      }),
      earnings.create({
        operator_id: '77',
        order_id: '9002',
        market_id: '37',
        amount: 7_000,
        order_total_price: 140_000,
      }),
      // O'chirilgan (rollback) yozuv — hisobga kirmaydi.
      earnings.create({
        operator_id: '77',
        order_id: '9003',
        market_id: '37',
        amount: 99_000,
        isDeleted: true,
      }),
      // Boshqa operator — 77 ga chiqmasligi kerak.
      earnings.create({
        operator_id: '42',
        order_id: '9004',
        market_id: '121',
        amount: 50_000,
        order_total_price: 1_000_000,
      }),
    ]);
    await payments.save([
      payments.create({
        operator_id: '77',
        market_id: '37',
        amount: 4_000,
        note: 'avans',
      }),
      payments.create({ operator_id: '42', amount: 30_000, note: 'begona' }),
    ]);
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('balance — faqat o`z yozuvlari: earned 12 000, paid 4 000, balance 8 000', async () => {
    const res: any = await service.findOperatorBalance({ operator_id: '77' });

    expect(res.data).toEqual({
      operator_id: '77',
      earned: 12_000,
      paid: 4_000,
      balance: 8_000,
    });
  });

  it('earnings / payments — faqat o`z qatorlari (boshqa operator va o`chirilgan yo`q), shakl { rows, total, limit, offset }', async () => {
    const earnings: any = await service.listOperatorEarnings({
      operator_id: '77',
    });
    const payments: any = await service.listOperatorPayments({
      operator_id: '77',
    });

    expect(earnings.data).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(
      (earnings.data.rows as OperatorEarning[]).map((r) => r.order_id).sort(),
    ).toEqual(['9001', '9002']);
    expect(
      (earnings.data.rows as OperatorEarning[]).every(
        (r) => r.operator_id === '77',
      ),
    ).toBe(true);
    expect(payments.data).toMatchObject({ total: 1 });
    expect(payments.data.rows[0]).toMatchObject({
      operator_id: '77',
      amount: 4_000,
      note: 'avans',
    });
  });

  it('limit/offset — sahifalash', async () => {
    const page: any = await service.listOperatorEarnings({
      operator_id: '77',
      limit: 1,
      offset: 1,
    });

    expect(page.data).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page.data.rows).toHaveLength(1);
  });

  it('komissiyasi belgilanmagan operator — 0/0/0 va bo`sh ro`yxat (403/404 emas)', async () => {
    const balance: any = await service.findOperatorBalance({
      operator_id: '555',
    });
    const earnings: any = await service.listOperatorEarnings({
      operator_id: '555',
    });
    const payments: any = await service.listOperatorPayments({
      operator_id: '555',
    });

    expect(balance.statusCode).toBe(200);
    expect(balance.data).toEqual({
      operator_id: '555',
      earned: 0,
      paid: 0,
      balance: 0,
    });
    expect(earnings.data).toMatchObject({ rows: [], total: 0 });
    expect(payments.data).toMatchObject({ rows: [], total: 0 });
  });
});
