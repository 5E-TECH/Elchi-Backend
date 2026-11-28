import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FinancialSource_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

/**
 * `finance.pnl.series` — kompaniya P&L seriyasi HAQIQIY Postgres'da (ega
 * 2026-11-28: investor ulushi va tizim grafigi shu manbadan):
 *   • daromad — sotuv foydasi, uning qaytarilishi, pickup haqi;
 *   • xarajat — qo'lda chiqim, ish haqi, hisoblar, qo'shimcha xarajat va
 *     uning qaytarilishi (`rollback-extra:*`);
 *   • qo'lda kirim — alohida, sof foydaga kirmaydi;
 *   • investorga foyda to'lovi (`investor-profit:*`) — umuman kirmaydi;
 *   • kun — Toshkent ish kuni (19:30 UTC = ertasi 00:30 Toshkent).
 * Env berilmasa skip.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('finance.pnl.series — P&L seriyasi, haqiqiy Postgres', () => {
  const schema = `spec_pnl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

    const repo = db.getRepository(FinancialBalanceHistory);
    const rows: Array<
      [string, FinancialSource_type, number, string?, boolean?]
    > = [
      // 1-noyabr (Toshkent)
      ['2026-11-01T06:00:00Z', FinancialSource_type.SELL_PROFIT, 30000],
      ['2026-11-01T07:00:00Z', FinancialSource_type.SELL_PROFIT, 20000],
      ['2026-11-01T08:00:00Z', FinancialSource_type.MANUAL_EXPENSE, -15000],
      ['2026-11-01T09:00:00Z', FinancialSource_type.MANUAL_INCOME, 1000000],
      // Investorga foyda to'lovi — P&L ga kirmaydi.
      [
        '2026-11-01T10:00:00Z',
        FinancialSource_type.MANUAL_EXPENSE,
        -9999,
        'investor-profit:42',
      ],
      // O'chirilgan qator — kirmaydi.
      [
        '2026-11-01T11:00:00Z',
        FinancialSource_type.SELL_PROFIT,
        77777,
        '',
        true,
      ],
      // 1-noyabr 23:30 UTC = 2-noyabr 04:30 Toshkent → 2-noyabr.
      ['2026-11-01T23:30:00Z', FinancialSource_type.PICKUP_FEE, 5000],
      ['2026-11-02T06:00:00Z', FinancialSource_type.SALARY, -40000],
      ['2026-11-02T06:10:00Z', FinancialSource_type.BILLS, -1000],
      ['2026-11-02T06:20:00Z', FinancialSource_type.SELL_EXTRA_COST, -2000],
      ['2026-11-02T06:30:00Z', FinancialSource_type.CANCEL_EXTRA_COST, -500],
      // Qo'shimcha xarajat qaytarildi — xarajat kamayadi.
      [
        '2026-11-02T06:40:00Z',
        FinancialSource_type.CORRECTION,
        2000,
        'rollback-extra:1',
      ],
      // Sotuv qaytarildi — daromad kamayadi.
      [
        '2026-11-02T06:50:00Z',
        FinancialSource_type.CORRECTION,
        -3000,
        'rollback:1',
      ],
      // Dekabr — oylik seriyada alohida.
      ['2026-12-03T06:00:00Z', FinancialSource_type.SELL_PROFIT, 10000],
    ];
    let balance = 0;
    let n = 0;
    for (const [at, source, amount, key, deleted] of rows) {
      n += 1;
      const saved = await repo.save(
        repo.create({
          amount,
          balance_before: balance,
          balance_after: balance + amount,
          source_type: source,
          dedup_key: key || `spec:${n}`,
          isDeleted: deleted === true,
        }),
      );
      await repo.update({ id: saved.id }, { createdAt: new Date(at) });
      if (!deleted) balance += amount;
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.destroy();
  });

  it('⭐ kunlik: daromad, xarajat, sof foyda, qo`lda kirim alohida', async () => {
    const res: any = await service.financialPnlSeries({
      from_day: '2026-11-01',
      to_day: '2026-11-30',
    });
    expect(res.data.granularity).toBe('day');
    expect(res.data.items).toEqual([
      {
        period: '2026-11-01',
        gross: 50000,
        opex: 15000,
        net: 35000,
        other_income: 1000000,
      },
      {
        period: '2026-11-02',
        gross: 5000 - 3000,
        opex: 40000 + 1000 + 2000 + 500 - 2000,
        net: 2000 - 41500,
        other_income: 0,
      },
    ]);
    expect(res.data.totals).toEqual({
      gross: 52000,
      opex: 56500,
      net: -4500,
      other_income: 1000000,
    });
  });

  it('oylik: noyabr va dekabr', async () => {
    const res: any = await service.financialPnlSeries({
      from_day: '2026-10-01',
      to_day: '2026-12-31',
      granularity: 'month',
    });
    expect(res.data.items.map((i: any) => [i.period, i.gross, i.net])).toEqual([
      ['2026-11', 52000, -4500],
      ['2026-12', 10000, 10000],
    ]);
  });

  it('oraliq chegarasi: to_day dan keyingi kun kirmaydi', async () => {
    const res: any = await service.financialPnlSeries({
      from_day: '2026-11-02',
      to_day: '2026-11-02',
    });
    expect(res.data.items.map((i: any) => i.period)).toEqual(['2026-11-02']);
  });

  it.each([
    [{ from_day: '2026-11-31' }],
    [{ from_day: '01.11.2026' }],
    [{ from_day: '2026-12-01', to_day: '2026-11-01' }],
    [{ from_day: '2000-01-01', to_day: '2026-11-01' }],
  ])('%p → 400', async (input) => {
    const err = await service.financialPnlSeries(input).catch((e) => e);
    expect(err?.getError?.()?.statusCode).toBe(400);
  });
});
