import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  FinancialSource_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';

/**
 * Haqiqiy Postgres (FINANCE_OPERATOR_PG_TEST_URI bo'lmasa skip):
 *  • 1bz6tOle — CLICK to'lovlari kuryer/market qarz hisobini naqd/karta
 *    bo'yicha soxta bo'lib qo'ymaydi; invariant har harakatdan keyin.
 *  • IgR4FVsR — qo'lda kirim/chiqim P&L daftariga AYNI tranzaksiyada;
 *    daftar yiqilsa kassa ham rollback; SUM(kassa manual) == SUM(FBH manual).
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('B4 (1bz6tOle, IgR4FVsR) — haqiqiy Postgres', () => {
  const schema = `spec_b4_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory],
      synchronize: true,
    });
    await db.initialize();
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({})) } as never,
      outbox as never,
    );
    // Fon follow-up (market sinxroni) bu testda kerak emas.
    jest
      .spyOn(service as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  const seed = async (
    user_id: string,
    cashbox_type: Cashbox_type,
    cash = 0,
    card = 0,
  ) =>
    db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id,
        cashbox_type,
        balance: cash + card,
        balance_cash: cash,
        balance_card: card,
      }),
    );

  const box = (user_id: string, cashbox_type: Cashbox_type) =>
    db.getRepository(Cashbox).findOneByOrFail({ user_id, cashbox_type });

  /** Sotuv oyog'i — order-service outbox'i yuboradigan shakl (usulsiz). */
  const saleLeg = (
    user_id: string,
    cashbox_type: Cashbox_type,
    amount: number,
    source_id: string,
  ) =>
    service.updateBalance({
      user_id,
      cashbox_type,
      amount,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id,
    } as never);

  /**
   * Invariant (1bz6tOle): har kassa uchun balance == cash + card; MAIN'da usul
   * bo'yicha manfiy yo'q; qarz hisoblarida (FOR_COURIER/FOR_MARKET) karta
   * chelagi doim 0.
   */
  const assertInvariant = async () => {
    const all = await db.getRepository(Cashbox).find();
    for (const cb of all) {
      expect(Number(cb.balance)).toBeCloseTo(
        Number(cb.balance_cash) + Number(cb.balance_card),
        2,
      );
      if (cb.cashbox_type === Cashbox_type.MAIN) {
        expect(Number(cb.balance_cash)).toBeGreaterThanOrEqual(0);
        expect(Number(cb.balance_card)).toBeGreaterThanOrEqual(0);
      }
      if (
        cb.cashbox_type === Cashbox_type.FOR_COURIER ||
        cb.cashbox_type === Cashbox_type.FOR_MARKET
      ) {
        expect(Number(cb.balance_card)).toBe(0);
      }
    }
  };

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
  });

  describe('1bz6tOle', () => {
    it('⭐ sotuv (CASH) → kuryer +X; CLICK bilan X to`lov → kuryer balance_cash 0, card 0; MAIN kartada', async () => {
      await seed('0', Cashbox_type.MAIN);
      await seed('209', Cashbox_type.FOR_COURIER);
      await saleLeg('209', Cashbox_type.FOR_COURIER, 5_000_000, '7001');

      const res = await service.paymentsFromCourier({
        courier_id: '209',
        amount: 5_000_000,
        payment_method: PaymentMethod.CLICK,
        dedup_epoch: 'pay-1',
      });

      expect(res?.statusCode).toBe(201);
      const courier = await box('209', Cashbox_type.FOR_COURIER);
      expect(Number(courier.balance)).toBe(0);
      expect(Number(courier.balance_cash)).toBe(0);
      expect(Number(courier.balance_card)).toBe(0);
      const main = await box('0', Cashbox_type.MAIN);
      expect(Number(main.balance_card)).toBe(5_000_000);
      expect(Number(main.balance_cash)).toBe(0);
      await assertInvariant();
    });

    it('CLICK bilan kuryer qarzidan ortiq → 400, hech narsa yozilmaydi', async () => {
      await seed('0', Cashbox_type.MAIN);
      await seed('209', Cashbox_type.FOR_COURIER);
      await saleLeg('209', Cashbox_type.FOR_COURIER, 100_000, '7002');

      await expect(
        service.paymentsFromCourier({
          courier_id: '209',
          amount: 100_001,
          payment_method: PaymentMethod.CLICK,
          dedup_epoch: 'pay-2',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      expect(Number((await box('209', Cashbox_type.FOR_COURIER)).balance)).toBe(
        100_000,
      );
      expect(await db.getRepository(CashboxHistory).count()).toBe(1);
    });

    it('paymentsToMarket(CLICK): MAIN karta qoldig`idan oshsa → 400 (naqd yetarli bo`lsa ham), rollback', async () => {
      await seed('0', Cashbox_type.MAIN, 5_000_000, 100_000);
      await seed('201', Cashbox_type.FOR_MARKET);
      await saleLeg('201', Cashbox_type.FOR_MARKET, 900_000, '7003');

      await expect(
        service.paymentsToMarket({
          market_id: '201',
          amount: 300_000,
          payment_method: PaymentMethod.CLICK,
          dedup_epoch: 'pay-3',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      const main = await box('0', Cashbox_type.MAIN);
      expect(Number(main.balance_card)).toBe(100_000);
      expect(Number((await box('201', Cashbox_type.FOR_MARKET)).balance)).toBe(
        900_000,
      );
    });

    it('⭐ invariant: aralash ketma-ketlikdan keyin balance == cash + card, MAIN manfiy emas, qarz hisobida karta 0', async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
      await seed('209', Cashbox_type.FOR_COURIER);
      await seed('201', Cashbox_type.FOR_MARKET);

      await saleLeg('209', Cashbox_type.FOR_COURIER, 800_000, '8001');
      await saleLeg('201', Cashbox_type.FOR_MARKET, 600_000, '8001');
      await assertInvariant();
      await service.paymentsFromCourier({
        courier_id: '209',
        amount: 300_000,
        payment_method: PaymentMethod.CLICK,
        dedup_epoch: 'mix-1',
      });
      await assertInvariant();
      await service.paymentsFromCourier({
        courier_id: '209',
        amount: 200_000,
        payment_method: PaymentMethod.CASH,
        dedup_epoch: 'mix-2',
      });
      await assertInvariant();
      await service.paymentsFromCourier({
        courier_id: '209',
        amount: 250_000,
        payment_method: PaymentMethod.CLICK_TO_MARKET,
        market_id: '201',
        dedup_epoch: 'mix-3',
      });
      await assertInvariant();
      await service.paymentsToMarket({
        market_id: '201',
        amount: 100_000,
        payment_method: PaymentMethod.CLICK,
        dedup_epoch: 'mix-4',
      });
      await assertInvariant();

      const courier = await box('209', Cashbox_type.FOR_COURIER);
      expect(Number(courier.balance)).toBe(50_000);
      expect(Number(courier.balance_cash)).toBe(50_000);
      const market = await box('201', Cashbox_type.FOR_MARKET);
      expect(Number(market.balance)).toBe(250_000);
      const main = await box('0', Cashbox_type.MAIN);
      // cash: 1 000 000 + 200 000; card: +300 000 +250 000 −250 000 −100 000.
      expect(Number(main.balance_cash)).toBe(1_200_000);
      expect(Number(main.balance_card)).toBe(200_000);
      // gEdrZxMz: click_to_market ikkita siljish (`:m` bilan) navbatga qo'ydi.
      const advances = outbox.enqueue.mock.calls.map(
        (call) => (call[2] as { level: string; request_id?: string }) ?? {},
      );
      expect(advances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'courier_to_branch',
            request_id: 'mix-3',
          }),
          expect.objectContaining({
            level: 'hq_to_market',
            request_id: 'mix-3:m',
          }),
        ]),
      );
    });
  });

  describe('IgR4FVsR', () => {
    it('spend/fill (financial_ledger) — kassa harakati bilan FBH yozuvi; kalit cashbox_history id', async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);

      await service.spendMoney({
        user_id: '1',
        amount: 150_000,
        comment: 'Ijara',
        created_by: '1',
        dedup_epoch: 'idem-1',
        financial_ledger: true,
      });
      await service.fillTheCashbox({
        user_id: '1',
        amount: 40_000,
        created_by: '1',
        dedup_epoch: 'idem-2',
        financial_ledger: true,
      });

      const history = await db
        .getRepository(CashboxHistory)
        .find({ order: { id: 'ASC' } });
      const ledger = await db
        .getRepository(FinancialBalanceHistory)
        .find({ order: { id: 'ASC' } });
      expect(ledger).toHaveLength(2);
      expect(ledger[0]).toMatchObject({
        source_type: FinancialSource_type.MANUAL_EXPENSE,
        dedup_key: `cashbox-history:${history[0].id}`,
        comment: 'Ijara',
      });
      expect(Number(ledger[0].amount)).toBe(-150_000);
      expect(ledger[1]).toMatchObject({
        source_type: FinancialSource_type.MANUAL_INCOME,
        dedup_key: `cashbox-history:${history[1].id}`,
      });
      expect(Number(ledger[1].amount)).toBe(40_000);
      expect(Number(ledger[1].balance_after)).toBe(-110_000);
    });

    it('takroriy so`rov (ayni dedup_epoch) — na kassa, na FBH ikki marta yoziladi', async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
      const dto = {
        user_id: '1',
        amount: 10_000,
        dedup_epoch: 'idem-dup',
        financial_ledger: true,
      };
      await service.spendMoney(dto);
      const second = await service.spendMoney(dto);

      expect(second?.data?.idempotent).toBe(true);
      expect(await db.getRepository(CashboxHistory).count()).toBe(1);
      expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(1);
      expect(Number((await box('0', Cashbox_type.MAIN)).balance)).toBe(990_000);
    });

    it('⭐ FBH yozuvi yiqilsa kassa harakati ham rollback (bitta commit)', async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
      await db.query(
        `ALTER TABLE "${schema}".financial_balance_history
          ADD CONSTRAINT spec_b4_no_expense CHECK (amount >= 0)`,
      );
      try {
        await expect(
          service.spendMoney({
            user_id: '1',
            amount: 150_000,
            dedup_epoch: 'idem-fail',
            financial_ledger: true,
          }),
        ).rejects.toBeTruthy();
      } finally {
        await db.query(
          `ALTER TABLE "${schema}".financial_balance_history
            DROP CONSTRAINT spec_b4_no_expense`,
        );
      }
      expect(await db.getRepository(CashboxHistory).count()).toBe(0);
      expect(await db.getRepository(FinancialBalanceHistory).count()).toBe(0);
      expect(Number((await box('0', Cashbox_type.MAIN)).balance)).toBe(
        1_000_000,
      );
    });

    it('⭐ invariant: N ta qo`lda operatsiyadan keyin SUM(kassa manual) == SUM(FBH manual) (MAIN + BRANCH)', async () => {
      await seed('0', Cashbox_type.MAIN, 2_000_000, 500_000);
      await seed('15', Cashbox_type.BRANCH, 300_000, 0);
      const ops: Array<() => Promise<unknown>> = [
        () =>
          service.spendMoney({
            user_id: '1',
            amount: 120_000,
            dedup_epoch: 'n-1',
            financial_ledger: true,
          }),
        () =>
          service.fillTheCashbox({
            user_id: '1',
            amount: 75_000,
            type: PaymentMethod.CLICK,
            dedup_epoch: 'n-2',
            financial_ledger: true,
          }),
        () =>
          service.spendMoney({
            user_id: '15',
            cashbox_type: Cashbox_type.BRANCH,
            amount: 50_000,
            dedup_epoch: 'n-3',
            financial_ledger: true,
          }),
        () =>
          service.fillTheCashbox({
            user_id: '15',
            cashbox_type: Cashbox_type.BRANCH,
            amount: 20_000,
            dedup_epoch: 'n-4',
            financial_ledger: true,
          }),
        () =>
          service.spendMoney({
            user_id: '1',
            amount: 33_333.33,
            type: PaymentMethod.CLICK,
            dedup_epoch: 'n-5',
            financial_ledger: true,
          }),
      ];
      // Parallel ham ishga tushiriladi — advisory qulf daftar zanjirini
      // buzmasligi kerak.
      await Promise.all(ops.map((op) => op()));

      const [{ cashbox_sum }] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN operation_type = 'income' THEN amount ELSE -amount END), 0)::text AS cashbox_sum
           FROM "${schema}".cashbox_history
          WHERE source_type IN ('manual_income', 'manual_expense')`,
      );
      const [{ ledger_sum }] = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS ledger_sum
           FROM "${schema}".financial_balance_history
          WHERE source_type IN ('manual_income', 'manual_expense')`,
      );
      expect(Number(cashbox_sum)).toBeCloseTo(-108_333.33, 2);
      expect(Number(ledger_sum)).toBeCloseTo(Number(cashbox_sum), 2);

      // Daftar zanjiri uzilmagan: har qator balance_before == oldingi after.
      const chain = await db
        .getRepository(FinancialBalanceHistory)
        .find({ order: { id: 'ASC' } });
      expect(chain).toHaveLength(5);
      let running = 0;
      for (const row of chain) {
        expect(Number(row.balance_before)).toBeCloseTo(running, 2);
        running = Number(row.balance_after);
      }
      expect(running).toBeCloseTo(-108_333.33, 2);
    });
  });
});
