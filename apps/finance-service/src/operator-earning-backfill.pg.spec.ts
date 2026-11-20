import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

/**
 * 2026-11-20 — `finance.operator.earning.backfill`: sotuvda komissiya
 * belgilanmagan bo'lgan o'tgan sotuvlarga JORIY stavka bilan ulush, HAQIQIY
 * Postgres'da (o'z vaqtinchalik sxemasi):
 *  - faqat qatori UMUMAN yo'q buyurtmalar (tirik va rollback qilingan qator
 *    tegilmaydi);
 *  - `dry_run` — hech narsa yozilmaydi;
 *  - takror / parallel — `ON CONFLICT DO NOTHING`, ikkinchi qator yo'q;
 *  - stavka yo'q — hech narsa yozilmaydi.
 * Env (`FINANCE_OPERATOR_PG_TEST_URI` / `FINANCE_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const MARKET = '12';
const OPERATOR = '42';

describePg('operator earning backfill (haqiqiy Postgres)', () => {
  const schema = `spec_ebf_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  let commission: { commission_type: string | null; commission_value: number } =
    { commission_type: 'percent', commission_value: 5 };
  const identity = {
    send: jest.fn(() => of({ statusCode: 200, data: { ...commission } })),
  };
  const earnings = () => db.getRepository(OperatorEarning);

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
      extra: { max: 6 },
    });
    await db.initialize();
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      {} as never,
      {} as never,
      db.getRepository(OperatorEarning),
      db.getRepository(OperatorPayment),
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      {} as never,
      {} as never,
      identity as never,
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
    activityLog.log.mockClear();
    identity.send.mockClear();
    commission = { commission_type: 'percent', commission_value: 5 };
    await db.query(
      `TRUNCATE TABLE "${schema}".operator_earnings RESTART IDENTITY CASCADE`,
    );
    await earnings().save([
      // Sotuvda yozilgan (tirik) — o'zgarmaydi.
      earnings().create({
        operator_id: OPERATOR,
        order_id: '7001',
        market_id: MARKET,
        amount: 3000,
        commission_type: 'fixed',
        commission_value: 3000,
        order_total_price: 100000,
      }),
      // Rollback qilingan (o'chirilgan) — tegilmaydi.
      earnings().create({
        operator_id: OPERATOR,
        order_id: '7002',
        market_id: MARKET,
        amount: 4000,
        isDeleted: true,
      }),
    ]);
  });

  const ORDERS = [
    { order_id: '7001', total_price: 100000, market_id: MARKET },
    { order_id: '7002', total_price: 80000, market_id: MARKET },
    { order_id: '7003', total_price: 200000, market_id: MARKET },
    { order_id: '7004', total_price: 0, market_id: MARKET },
    { order_id: '7003', total_price: 200000, market_id: MARKET },
    { order_id: 'abc', total_price: 1, market_id: MARKET },
  ];
  type Summary = Record<string, unknown>;
  const run = async (dryRun: boolean, orders: unknown[] = ORDERS) =>
    (
      (await finance.backfillOperatorEarnings({
        operator_id: OPERATOR,
        orders: orders as never,
        dry_run: dryRun,
        requested_by: { id: MARKET, role: 'market' },
      })) as { data: Summary }
    ).data;

  it('⭐ oldindan ko`rish — hech narsa yozilmaydi; faqat qatori yo`q buyurtmalar, joriy stavka bilan', async () => {
    const preview = await run(true);

    expect(preview).toMatchObject({
      sold_orders: 4,
      already_recorded: 2,
      missing: 2,
      to_record: 1,
      amount: 10000,
      commission_type: 'percent',
      commission_value: 5,
      created: 0,
      dry_run: true,
    });
    expect(await earnings().count()).toBe(2);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('⭐ yozish — yangi qator snapshot bilan; mavjud va rollback qatorlari o`zgarmaydi; takror — ikkinchi qator yo`q', async () => {
    const first = await run(false);
    expect(first).toMatchObject({
      created: 1,
      created_amount: 10000,
      dry_run: false,
    });

    const rows = await earnings().find({ order: { order_id: 'ASC' } });
    expect(
      rows.map((row) => [row.order_id, Number(row.amount), row.isDeleted]),
    ).toEqual([
      ['7001', 3000, false],
      ['7002', 4000, true],
      ['7003', 10000, false],
    ]);
    const created = rows.find((row) => row.order_id === '7003');
    expect(created).toMatchObject({
      operator_id: OPERATOR,
      market_id: MARKET,
      commission_type: 'percent',
    });
    expect(Number(created?.commission_value)).toBe(5);
    expect(Number(created?.order_total_price)).toBe(200000);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'OperatorEarning',
        new_value: { created: 1, amount: 10000 },
        metadata: expect.objectContaining({
          reason: 'backfill',
          requested_by_id: MARKET,
        }),
      }),
    );

    const again = await run(false);
    expect(again).toMatchObject({ to_record: 0, created: 0 });
    expect(await earnings().count()).toBe(3);
  });

  it('parallel ikki so`rov — bitta qator (ON CONFLICT DO NOTHING)', async () => {
    const results = await Promise.all([run(false), run(false)]);
    expect(results.map((item) => item.created).sort()).toEqual([0, 1]);
    expect(await earnings().count({ where: { order_id: '7003' } })).toBe(1);
  });

  it('stavka belgilanmagan — hech narsa yozilmaydi', async () => {
    commission = { commission_type: null, commission_value: 0 };
    const res = await run(false);
    expect(res).toMatchObject({
      missing: 2,
      to_record: 0,
      amount: 0,
      created: 0,
    });
    expect(await earnings().count()).toBe(2);
  });

  it('qat`iy summa — har sotilgan buyurtmaga; bo`sh ro`yxat — identity so`ralmaydi; 5000 dan ko`p — 400', async () => {
    commission = { commission_type: 'fixed', commission_value: 2500 };
    expect(await run(true)).toMatchObject({ to_record: 2, amount: 5000 });

    expect(await run(true, [])).toMatchObject({ sold_orders: 0, to_record: 0 });
    identity.send.mockClear();
    await run(true, []);
    expect(identity.send).not.toHaveBeenCalled();

    const many = Array.from({ length: 5001 }, (_, i) => ({
      order_id: String(10_000 + i),
      total_price: 1000,
    }));
    await expect(run(true, many)).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
  });
});
