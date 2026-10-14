import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';

/**
 * (IaMK2tf2) /financial-balance "Marketlar" / "Kuryerlar" ro'yxatlari —
 * HAQIQIY Postgres'da: ro'yxat so'rovi (ABS bo'yicha tartib, nol va
 * o'chirilgan kassalarsiz) va jami (`sumCashboxBalanceByType`) BIR XIL
 * filtrda — Σ qatorlar == karta "jami" (TC2). Env berilmasa skip.
 */
const pgUri =
  process.env.FINANCE_PG_TEST_URI ?? process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('IaMK2tf2 - moliyaviy balans ro`yxatlari, haqiqiy Postgres', () => {
  const schema = `spec_fblists_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  const identity = {
    send: jest.fn((_pattern: { cmd: string }, payload: { ids: string[] }) =>
      of({
        data: payload.ids
          .filter((id) => id !== '104')
          .map((id) => ({
            id,
            name: `Egasi ${id}`,
            phone_number: '+998900000000',
            region_id: 7,
            salary: 999,
          })),
      }),
    ),
  };

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
      identity as never,
      {} as never,
    );

    const repo = db.getRepository(Cashbox);
    const rows: Array<[string, Cashbox_type, number, boolean?]> = [
      ['101', Cashbox_type.FOR_MARKET, 1000],
      ['102', Cashbox_type.FOR_MARKET, -2500.5],
      ['103', Cashbox_type.FOR_MARKET, 0],
      ['104', Cashbox_type.FOR_MARKET, 300],
      ['105', Cashbox_type.FOR_MARKET, 7000, true],
      ['201', Cashbox_type.FOR_COURIER, 450],
      ['202', Cashbox_type.FOR_COURIER, 0],
    ];
    for (const [userId, type, balance, deleted] of rows) {
      await repo.save(
        repo.create({
          user_id: userId,
          cashbox_type: type,
          balance,
          balance_cash: balance,
          balance_card: 0,
          isDeleted: deleted === true,
        }),
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  type ListResult = {
    items: Array<{
      user_id: string;
      balance: number;
      user: { name: string | null } | null;
    }>;
    nonZeroCount: number;
    truncated: boolean;
  };
  const list = (type: Cashbox_type): Promise<ListResult> =>
    (
      service as unknown as {
        listNonZeroCashboxesWithOwners: (
          t: Cashbox_type,
        ) => Promise<ListResult>;
      }
    ).listNonZeroCashboxesWithOwners(type);
  const total = (type: Cashbox_type): Promise<number> =>
    (
      service as unknown as {
        sumCashboxBalanceByType: (t: Cashbox_type) => Promise<number>;
      }
    ).sumCashboxBalanceByType(type);

  it('marketlar: nol va o`chirilgan kassasiz, |balans| bo`yicha, Σ == jami', async () => {
    const result = await list(Cashbox_type.FOR_MARKET);

    expect(result.items.map((row) => row.user_id)).toEqual([
      '102',
      '101',
      '104',
    ]);
    expect(result.nonZeroCount).toBe(3);
    expect(result.truncated).toBe(false);
    // Imzoli balans saqlanadi (manfiy = market bizga qarzdor).
    expect(result.items[0].balance).toBe(-2500.5);
    const sum = result.items.reduce((acc, row) => acc + row.balance, 0);
    expect(sum).toBeCloseTo(await total(Cashbox_type.FOR_MARKET), 2);
    // Egasi nomi identity'dan; topilmagan ega — user: null (qator qoladi).
    expect(result.items[1].user?.name).toBe('Egasi 101');
    expect(result.items[2].user).toBeNull();
    // Maxfiy maydon sizmaydi.
    expect(JSON.stringify(result.items)).not.toMatch(/salary/);
  });

  it('kuryerlar: faqat nol bo`lmagan kassa, Σ == jami', async () => {
    const result = await list(Cashbox_type.FOR_COURIER);

    expect(result.items.map((row) => row.user_id)).toEqual(['201']);
    expect(result.items[0].balance).toBe(450);
    expect(await total(Cashbox_type.FOR_COURIER)).toBe(450);
  });
});
