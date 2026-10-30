import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from '../entities/finance-daily-snapshot.entity';
import { FinanceDailySnapshotService } from './finance-daily-snapshot.service';
import { FinanceDailyService } from './finance-daily.service';
import { PaymentsMetaService } from './payments-meta.service';

/**
 * qzjTMWPb / uzWcMR1C — HAQIQIY Postgres'da: kunlik snapshot job'i
 * (backfill, idempotentlik, ko'p replika), kunlik agregat endpointlari va
 * /payments KPI meta. Pul jadvallari (kassa balansi, tarix, daftar) job'dan
 * keyin BAYT-BAYT o'zgarmagani tekshiriladi. Env berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

/** Toshkent vaqti → UTC Date ('2026-10-01 10:00' = 05:00Z). */
const tk = (local: string) => new Date(`${local.replace(' ', 'T')}:00+05:00`);

describePg('qzjTMWPb — kunlik balans snapshot va agregat (Postgres)', () => {
  const schema = `spec_finagg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let snapshot: FinanceDailySnapshotService;
  let daily: FinanceDailyService;
  let meta: PaymentsMetaService;
  const ids: Record<string, string> = {};
  const orderClient = {
    send: jest.fn(() => of({ data: { chain_receivable: 1000 } })),
  };
  const integrationClient = {
    send: jest.fn(() => of({ data: { outstanding_amount: 200 } })),
  };
  const identityClient = {
    send: jest.fn((_p: unknown, payload: { ids: string[] }) =>
      of({ data: payload.ids.map((id) => ({ id, name: `Market ${id}` })) }),
    ),
  };
  // «Bugun» — 2026-10-06 10:00 (Toshkent); kecha — 05.10.
  const NOW = tk('2026-10-06 10:00');
  // Job yarim tundan keyin yuradi (jonli qarz faqat 6 soat oynasida olinadi).
  const CAPTURE = tk('2026-10-06 00:20');

  const t = (entity: Parameters<DataSource['getMetadata']>[0]) =>
    db
      .getMetadata(entity)
      .tablePath.split('.')
      .map((part) => `"${part}"`)
      .join('.');

  const addCashbox = async (
    key: string,
    userId: string,
    type: string,
    balance: number,
    deleted = false,
  ) => {
    const rows: Array<{ id: string }> = await db.query(
      `INSERT INTO ${t(Cashbox)} ("user_id", "cashbox_type", "balance", "balance_cash", "balance_card", "is_deleted")
       VALUES ($1, $2, $3, $3, 0, $4) RETURNING "id"::text AS id`,
      [userId, type, balance, deleted],
    );
    ids[key] = rows[0].id;
  };

  const addHistory = async (
    key: string,
    op: 'income' | 'expense',
    source: string,
    amount: number,
    balanceAfter: number,
    at: string,
    extra: { created_by?: string; deleted?: boolean } = {},
  ) => {
    await db.query(
      `INSERT INTO ${t(CashboxHistory)}
         ("operation_type", "cashbox_id", "source_type", "amount", "balance_after",
          "balance_cash_after", "balance_card_after", "createdAt", "created_by", "is_deleted")
       VALUES ($1, $2, $3, $4, $5, $5, 0, $6, $7, $8)`,
      [
        op,
        ids[key],
        source,
        amount,
        balanceAfter,
        tk(at),
        extra.created_by ?? null,
        extra.deleted ?? false,
      ],
    );
  };

  const addLedger = async (amount: number, after: number, at: string) => {
    await db.query(
      `INSERT INTO ${t(FinancialBalanceHistory)}
         ("amount", "balance_before", "balance_after", "source_type", "createdAt")
       VALUES ($1, $2, $3, 'manual_income', $4)`,
      [amount, after - amount, after, tk(at)],
    );
  };

  const moneyFingerprint = async () => ({
    cashboxes: await db.query(
      `SELECT "id", "balance", "balance_cash", "balance_card", "updatedAt" FROM ${t(Cashbox)} ORDER BY "id"`,
    ),
    history: await db.query(
      `SELECT "id", "amount", "balance_after", "is_deleted", "updatedAt" FROM ${t(CashboxHistory)} ORDER BY "id"`,
    ),
    ledger: await db.query(
      `SELECT "id", "amount", "balance_after", "updatedAt" FROM ${t(FinancialBalanceHistory)} ORDER BY "id"`,
    ),
  });

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
        FinanceCashboxDaily,
        FinanceDailySnapshot,
      ],
      synchronize: true,
    });
    await db.initialize();
    snapshot = new FinanceDailySnapshotService(
      db,
      undefined,
      orderClient as never,
      integrationClient as never,
    );
    daily = new FinanceDailyService(db);
    meta = new PaymentsMetaService(db, identityClient as never);

    await addCashbox('main', '0', 'main', 1700);
    await addCashbox('mA', '101', 'markets', 500);
    await addCashbox('mB', '102', 'markets', -50);
    await addCashbox('mC', '103', 'markets', 300);
    await addCashbox('mGone', '104', 'markets', 999, true);
    await addCashbox('courierHq', '201', 'couriers', 400);
    await addCashbox('courierBr', '202', 'couriers', 70);
    await addCashbox('branch', '5', 'branch', 0);

    // 01.10 — asosiy kassa: +1000, −200 (kun oxiri 800); kun chegarasi:
    // 00:30 Toshkent (UTC'da hali 30.09) ham 01.10 ga tushadi.
    await addHistory(
      'main',
      'income',
      'manual_income',
      1000,
      1000,
      '2026-10-01 00:30',
      { created_by: '9' },
    );
    await addHistory(
      'main',
      'expense',
      'manual_expense',
      200,
      800,
      '2026-10-01 18:00',
    );
    await addHistory('mA', 'income', 'sell', 500, 500, '2026-10-01 12:00');
    // 02.10 — asosiy +500 (1300); o'chirilgan qator hisobga KIRMAYDI.
    await addHistory(
      'main',
      'income',
      'courier_payment',
      500,
      1300,
      '2026-10-02 09:00',
    );
    await addHistory(
      'main',
      'income',
      'courier_payment',
      99999,
      99999,
      '2026-10-02 10:00',
      { deleted: true },
    );
    await addHistory(
      'mB',
      'expense',
      'extra_cost',
      50,
      -50,
      '2026-10-02 11:00',
    );
    // 03.10 — harakat yo'q. 04.10 — asosiy −300 (1000); kuryer +400.
    await addHistory(
      'main',
      'expense',
      'market_payment',
      300,
      1000,
      '2026-10-04 23:59',
    );
    await addHistory(
      'courierHq',
      'income',
      'sell',
      400,
      400,
      '2026-10-04 15:00',
    );
    await addHistory('mC', 'income', 'sell', 300, 300, '2026-10-04 15:00');
    await addHistory('courierBr', 'income', 'sell', 70, 70, '2026-10-04 16:00');
    // 06.10 (bugun) — asosiy +700 (1700).
    await addHistory(
      'main',
      'income',
      'branch_to_main',
      700,
      1700,
      '2026-10-06 08:00',
    );

    await addLedger(100, 100, '2026-09-30 12:00');
    await addLedger(50, 150, '2026-10-01 12:00');
    await addLedger(-30, 120, '2026-10-02 12:00');
    await addLedger(200, 320, '2026-10-02 13:00');
    await addLedger(10, 330, '2026-10-06 09:00');
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it("snapshot'gacha: oqimlar bor, qoldiqlar `pending` (job hali yurmagan)", async () => {
    const res = await daily.historyDaily(
      { from_date: '2026-10-01', to_date: '2026-10-02' },
      NOW,
    );
    expect(res.data.balance_status).toBe('pending');
    expect(res.data.opening_balance).toBeNull();
    expect(res.data.days.map((d) => [d.date, d.income, d.expense])).toEqual([
      ['2026-10-01', 1000, 200],
      ['2026-10-02', 500, 0],
    ]);
  });

  it('backfill: tarixning birinchi kunidan KECHAGACHA, pul jadvallari o‘zgarmaydi', async () => {
    const before = await moneyFingerprint();
    const run = await snapshot.catchUp(CAPTURE);
    expect(run.processed).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    expect(run.stopped).toBeNull();
    expect(await moneyFingerprint()).toEqual(before);

    const snaps: Array<Record<string, unknown>> = await db.query(
      `SELECT to_char("snapshot_date", 'YYYY-MM-DD') AS day, "source",
              "main_balance"::float AS main, "market_cashbox_total"::float AS markets,
              "market_payable_total"::float AS payable, "courier_cashbox_total"::float AS couriers,
              "chain_receivable"::float AS chain, "provider_receivable"::float AS provider,
              "current_situation"::float AS situation, "ledger_balance"::float AS ledger
         FROM ${t(FinanceDailySnapshot)} ORDER BY 1`,
    );
    expect(snaps).toEqual([
      {
        day: '2026-10-01',
        source: 'backfill',
        main: 800,
        markets: 500,
        payable: 500,
        couriers: 0,
        chain: null,
        provider: null,
        situation: null,
        ledger: 150,
      },
      {
        day: '2026-10-02',
        source: 'backfill',
        main: 1300,
        markets: 450,
        payable: 500,
        couriers: 0,
        chain: null,
        provider: null,
        situation: null,
        ledger: 320,
      },
      {
        day: '2026-10-03',
        source: 'backfill',
        main: 1300,
        markets: 450,
        payable: 500,
        couriers: 0,
        chain: null,
        provider: null,
        situation: null,
        ledger: 320,
      },
      {
        day: '2026-10-04',
        source: 'backfill',
        main: 1000,
        markets: 750,
        payable: 800,
        couriers: 470,
        chain: null,
        provider: null,
        situation: null,
        ledger: 320,
      },
      // Kecha — jonli: holat = main + zanjir + kargo − market (financialBalance formulasi).
      {
        day: '2026-10-05',
        source: 'live',
        main: 1000,
        markets: 750,
        payable: 800,
        couriers: 470,
        chain: 1000,
        provider: 200,
        situation: 1450,
        ledger: 320,
      },
    ]);
    // O'chirilgan market kassasi (999) yig'indilarga kirmaydi.
  });

  it('idempotent: qayta yurgizish hech narsa yozmaydi; ikki replika parallel — dublikat yo‘q', async () => {
    const count = async () =>
      (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM ${t(FinanceCashboxDaily)}`,
        )
      )[0].n as number;
    const before = await count();
    const again = await snapshot.catchUp(CAPTURE);
    expect(again.processed).toEqual([]);

    // Oxirgi kunni o'chirib, ikki "replika"ni bir vaqtda yurgizamiz.
    await db.query(
      `DELETE FROM ${t(FinanceDailySnapshot)} WHERE "snapshot_date" = '2026-10-05'`,
    );
    await db.query(
      `DELETE FROM ${t(FinanceCashboxDaily)} WHERE "snapshot_date" = '2026-10-05'`,
    );
    const replicaB = new FinanceDailySnapshotService(
      db,
      undefined,
      orderClient as never,
      integrationClient as never,
    );
    const [a, b] = await Promise.all([
      snapshot.catchUp(CAPTURE),
      replicaB.catchUp(CAPTURE),
    ]);
    expect([...a.processed, ...b.processed]).toEqual(['2026-10-05']);
    expect(await count()).toBe(before);
    const dup: unknown[] = await db.query(
      `SELECT "snapshot_date", "cashbox_id" FROM ${t(FinanceCashboxDaily)}
        GROUP BY 1, 2 HAVING COUNT(*) > 1`,
    );
    expect(dup).toEqual([]);
  });

  it('teshik bo‘lsa (D−1 yo‘q) kun qurilmaydi — zanjir tartibi buzilmaydi', async () => {
    await db.query(
      `DELETE FROM ${t(FinanceDailySnapshot)} WHERE "snapshot_date" = '2026-10-03'`,
    );
    expect(await snapshot.snapshotDay('2026-10-04', null, NOW)).toBe('exists');
    await db.query(
      `DELETE FROM ${t(FinanceDailySnapshot)} WHERE "snapshot_date" = '2026-10-04'`,
    );
    expect(await snapshot.snapshotDay('2026-10-04', null, NOW)).toBe('gap');
    expect(await snapshot.snapshotDay('2026-10-03', null, NOW)).toBe('done');
    expect(await snapshot.snapshotDay('2026-10-04', null, NOW)).toBe('done');
  });

  it('GET /finance/history/daily — asosiy kassa: kunlik oqim, kun boshi/oxiri, bugun jonli', async () => {
    const res = await daily.historyDaily(
      { from_date: '2026-10-01', to_date: '2026-10-06' },
      NOW,
    );
    expect(res.data.balance_status).toBe('ok');
    expect(res.data.opening_balance).toBe(0);
    expect(res.data.closing_balance).toBe(1700);
    expect(res.data.totals).toEqual({
      income: 2200,
      expense: 500,
      net: 1700,
      income_count: 3,
      expense_count: 2,
    });
    expect(
      res.data.days.map((d) => [
        d.date,
        d.income,
        d.expense,
        d.opening_balance,
        d.closing_balance,
      ]),
    ).toEqual([
      ['2026-10-01', 1000, 200, 0, 800],
      ['2026-10-02', 500, 0, 800, 1300],
      ['2026-10-03', 0, 0, 1300, 1300],
      ['2026-10-04', 0, 300, 1300, 1000],
      ['2026-10-05', 0, 0, 1000, 1000],
      ['2026-10-06', 700, 0, 1000, 1700],
    ]);
  });

  it('M5: davr boshi qoldig‘i server tomonidan (100 qatorga bog‘liq emas) + filtr faqat oqimga', async () => {
    const res = await daily.historyDaily(
      {
        from_date: '2026-10-04',
        to_date: '2026-10-06',
        source_types: 'branch_to_main,market_payment',
      },
      NOW,
    );
    expect(res.data.filtered).toBe(true);
    expect(res.data.opening_balance).toBe(1300);
    expect(res.data.closing_balance).toBe(1700);
    expect(res.data.totals.income).toBe(700);
    expect(res.data.totals.expense).toBe(300);
  });

  it('market turi va user_id doirasi; kelajak kunlari null', async () => {
    const markets = await daily.historyDaily(
      {
        from_date: '2026-10-02',
        to_date: '2026-10-07',
        cashbox_type: 'markets',
      },
      NOW,
    );
    expect(markets.data.opening_balance).toBe(500);
    expect(markets.data.days.map((d) => d.closing_balance)).toEqual([
      450,
      450,
      750,
      750,
      750,
      null,
    ]);

    const one = await daily.historyDaily(
      {
        from_date: '2026-10-04',
        to_date: '2026-10-04',
        user_id: '201',
        cashbox_type: 'couriers',
      },
      NOW,
    );
    expect(one.data.scope.cashbox_ids).toEqual([ids.courierHq]);
    expect(one.data.days[0]).toMatchObject({
      income: 400,
      opening_balance: 0,
      closing_balance: 400,
    });

    const none = await daily.historyDaily({ user_id: '999999' }, NOW);
    expect(none.data.totals.income).toBe(0);
  });

  it('noto‘g‘ri sana / oraliq — 400', async () => {
    await expect(
      daily.historyDaily({ from_date: '2026-13-01' }, NOW),
    ).rejects.toThrow("from_date noto'g'ri");
    await expect(
      daily.historyDaily(
        { from_date: '2026-10-05', to_date: '2026-10-01' },
        NOW,
      ),
    ).rejects.toThrow();
    await expect(
      daily.historyDaily(
        { from_date: '2024-01-01', to_date: '2026-10-01' },
        NOW,
      ),
    ).rejects.toThrow('366');
    await expect(
      daily.historyDaily({ source_type: 'nope' }, NOW),
    ).rejects.toThrow();
  });

  it('GET /finance/financial-balance/daily — snapshot qatori va daftar (davr boshi, eng yuqori)', async () => {
    const res = await daily.financialBalanceDaily(
      { from_date: '2026-10-02', to_date: '2026-10-06' },
      NOW,
    );
    expect(res.data.ledger).toMatchObject({
      opening_balance: 150,
      closing_balance: 330,
      income: 210,
      expense: 30,
      net: 180,
      count: 3,
      peak: { date: '2026-10-06', balance: 330 },
    });
    expect(res.data.previous_day.snapshot?.main_balance).toBe(800);
    const yesterday = res.data.days.find((d) => d.date === '2026-10-05');
    expect(yesterday?.snapshot).toMatchObject({
      source: 'live',
      in_transit: 1200,
      markets_debt: -750,
      current_situation: 1450,
    });
    expect(
      res.data.days.find((d) => d.date === '2026-10-06')?.snapshot,
    ).toBeNull();
    expect(res.data.days.map((d) => d.ledger.closing_balance)).toEqual([
      320, 320, 320, 320, 330,
    ]);
  });

  it('uzWcMR1C — payments meta: qarzdor marketlar, top taqsimot, HQ kuryerlari', async () => {
    const res = await meta.paymentsMeta({
      hq_courier_ids: ['201', 'x', '999'],
      top: 1,
    });
    expect(res.data).toEqual({
      payable: {
        markets_count: 2,
        amount: 800,
        top_markets: [
          {
            market_id: '101',
            cashbox_id: ids.mA,
            name: 'Market 101',
            amount: 500,
            share: 62.5,
          },
        ],
        others: { count: 1, amount: 300, share: 37.5 },
      },
      hq_couriers: { count: 1, amount: 400 },
    });
  });
});
