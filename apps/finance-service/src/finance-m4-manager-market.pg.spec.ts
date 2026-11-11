import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';

/**
 * AUDIT M4 (2026-11-11) — menejerga «Marketga to'lov» (filial kassasidan) va
 * kuryer to'lovida «Marketga o'tkazma» (click_to_market) ochildi. Haqiqiy
 * Postgres (`FINANCE_OPERATOR_PG_TEST_URI`): kassa oyoqlari, qoldiq
 * qo'riqchisi, idempotentlik va daftar siljishlari (outbox) tartibi.
 *
 * Daftar tomoni (`branch_payable` / `courier_receivable`) —
 * order-service `settlement-m4-manager-market.pg.spec.ts`.
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('M4 — menejer orqali marketga to`lov — haqiqiy Postgres', () => {
  const schema = `spec_m4f_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
    // Fon follow-up (market buyurtmalari sinxroni) bu testda kerak emas.
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

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".financial_balance_history,
        "${schema}".cashboxes RESTART IDENTITY CASCADE`,
    );
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

  const box = async (user_id: string, cashbox_type: Cashbox_type) => {
    const row = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id, cashbox_type });
    return {
      balance: Number(row.balance),
      cash: Number(row.balance_cash),
      card: Number(row.balance_card),
    };
  };

  /** Outbox'ga navbatga qo'yilgan daftar siljishlari — tartibi bilan. */
  const advances = () =>
    outbox.enqueue.mock.calls
      .filter((call) => call[1] === 'order.settlement.advance')
      .map((call) => {
        const payload = call[2] as Record<string, unknown>;
        return [
          payload.level,
          payload.match_value,
          payload.amount,
          payload.request_id,
        ];
      });

  /**
   * Kompaniya holatining kassa qismi: HQ + filial + kuryer qo'lidagi pul
   * MINUS marketga qarz. Marketga to'lov uni o'zgartirmasligi kerak (pul
   * kompaniyadan chiqadi, qarz ham shuncha kamayadi).
   */
  const companyCash = async () => {
    const all = await db.getRepository(Cashbox).find();
    return all.reduce((sum, row) => {
      const balance = Number(row.balance);
      return row.cashbox_type === Cashbox_type.FOR_MARKET
        ? sum - balance
        : sum + balance;
    }, 0);
  };

  const historyRows = () =>
    db.getRepository(CashboxHistory).find({ order: { id: 'ASC' } });

  describe('«Marketga o`tkazma» (click_to_market) — menejer, filial kassasi orqali', () => {
    const pay = (dedup: string, amount = 300_000) =>
      service.paymentsFromCourier({
        courier_id: '209',
        amount,
        payment_method: PaymentMethod.CLICK_TO_MARKET,
        market_id: '201',
        receiver_user_id: '15',
        receiver_cashbox_type: Cashbox_type.BRANCH,
        created_by: '15001',
        dedup_epoch: dedup,
      });

    beforeEach(async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
      await seed('15', Cashbox_type.BRANCH, 100_000, 0);
      await seed('209', Cashbox_type.FOR_COURIER, 450_000);
      await seed('201', Cashbox_type.FOR_MARKET, 450_000);
    });

    it('⭐ filial kassasi sof 0; kuryer −X, market qarzi −X; 3 siljish tartib bilan', async () => {
      const before = await companyCash();
      const res = await pay('gw:ctm-1');

      expect(res?.statusCode).toBe(201);
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 100_000,
        cash: 100_000,
        card: 0,
      });
      expect((await box('209', Cashbox_type.FOR_COURIER)).balance).toBe(
        150_000,
      );
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(150_000);
      // HQ kassasiga tegilmaydi.
      expect(await box('0', Cashbox_type.MAIN)).toEqual({
        balance: 1_000_000,
        cash: 1_000_000,
        card: 0,
      });
      expect(await companyCash()).toBe(before);

      // To'rt oyoq bitta transfer_id bilan: kuryer −, filial + / −, market −.
      const legs = await historyRows();
      expect(legs).toHaveLength(4);
      expect(new Set(legs.map((leg) => leg.transfer_id)).size).toBe(1);
      expect(
        legs.map((leg) => [leg.source_type, leg.operation_type, leg.amount]),
      ).toEqual([
        [Source_type.COURIER_PAYMENT, Operation_type.EXPENSE, 300_000],
        [Source_type.COURIER_PAYMENT, Operation_type.INCOME, 300_000],
        [Source_type.MARKET_PAYMENT, Operation_type.EXPENSE, 300_000],
        [Source_type.MARKET_PAYMENT, Operation_type.EXPENSE, 300_000],
      ]);

      // Kuryer → filial, filial → HQ (filial qarzi soxta qolmasin), HQ → market.
      expect(advances()).toEqual([
        ['courier_to_branch', '209', 300_000, 'gw:ctm-1'],
        ['branch_to_hq', '15', 300_000, 'gw:ctm-1:b'],
        ['hq_to_market', '201', 300_000, 'gw:ctm-1:m'],
      ]);
    });

    it('takroriy so`rov (ayni Idempotency-Key) — pul ham, siljish ham bir marta', async () => {
      await pay('gw:ctm-2');
      outbox.enqueue.mockClear();
      const again = await pay('gw:ctm-2');

      expect(again?.data).toMatchObject({ idempotent: true });
      expect(await historyRows()).toHaveLength(4);
      expect(advances()).toEqual([]);
      expect((await box('209', Cashbox_type.FOR_COURIER)).balance).toBe(
        150_000,
      );
    });

    it('marketga qarzdan oshsa → 400, hech narsa yozilmaydi', async () => {
      await db
        .getRepository(Cashbox)
        .update(
          { user_id: '201', cashbox_type: Cashbox_type.FOR_MARKET },
          { balance: 100_000, balance_cash: 100_000 },
        );
      jest
        .spyOn(service as never, 'isCashboxDebtEnabled')
        .mockResolvedValueOnce(false as never);

      await expect(pay('gw:ctm-3')).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(await historyRows()).toHaveLength(0);
      expect(advances()).toEqual([]);
      expect((await box('209', Cashbox_type.FOR_COURIER)).balance).toBe(
        450_000,
      );
    });
  });

  describe('«Marketga to`lov» — menejer, filial kassasidan', () => {
    const pay = (
      dedup: string,
      amount: number,
      method: PaymentMethod = PaymentMethod.CASH,
    ) =>
      service.paymentsToMarket({
        market_id: '201',
        amount,
        payment_method: method,
        payer_cashbox_type: Cashbox_type.BRANCH,
        payer_user_id: '15',
        created_by: '15001',
        dedup_epoch: dedup,
      });

    beforeEach(async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 1_000_000);
      await seed('15', Cashbox_type.BRANCH, 500_000, 200_000);
      await seed('201', Cashbox_type.FOR_MARKET, 450_000);
    });

    it('⭐ naqd: filial kassasi −X, market qarzi −X, HQ tegilmaydi; filial → HQ, HQ → market siljishlari', async () => {
      const before = await companyCash();
      const res = await pay('gw:mp-1', 270_000);

      expect(res?.statusCode).toBe(200);
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 430_000,
        cash: 230_000,
        card: 200_000,
      });
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(180_000);
      expect(await box('0', Cashbox_type.MAIN)).toEqual({
        balance: 2_000_000,
        cash: 1_000_000,
        card: 1_000_000,
      });
      expect(await companyCash()).toBe(before);

      const legs = await historyRows();
      expect(legs).toHaveLength(2);
      expect(new Set(legs.map((leg) => leg.transfer_id)).size).toBe(1);
      const branchBox = await db
        .getRepository(Cashbox)
        .findOneByOrFail({ user_id: '15', cashbox_type: Cashbox_type.BRANCH });
      expect(legs[0]).toMatchObject({
        cashbox_id: branchBox.id,
        source_type: Source_type.MARKET_PAYMENT,
        operation_type: Operation_type.EXPENSE,
        source_user_id: '201',
        dedup_epoch: 'gw:mp-1',
      });

      expect(advances()).toEqual([
        ['branch_to_hq', '15', 270_000, 'gw:mp-1:b'],
        ['hq_to_market', '201', 270_000, 'gw:mp-1'],
      ]);
    });

    it('karta (click): filial karta chelagidan', async () => {
      await pay('gw:mp-2', 150_000, PaymentMethod.CLICK);
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 550_000,
        cash: 500_000,
        card: 50_000,
      });
    });

    it('filial kassasida yetmasa → 400 (HQ da pul bo`lsa ham), rollback', async () => {
      await expect(
        pay('gw:mp-3', 300_000, PaymentMethod.CLICK),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      await expect(pay('gw:mp-4', 500_001)).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 700_000,
        cash: 500_000,
        card: 200_000,
      });
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(450_000);
      expect(await historyRows()).toHaveLength(0);
      expect(advances()).toEqual([]);
    });

    it('takroriy so`rov — bir marta; boshqa kalit — yangi to`lov', async () => {
      await pay('gw:mp-5', 100_000);
      const again = await pay('gw:mp-5', 100_000);
      expect(again?.data).toMatchObject({ idempotent: true });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(400_000);

      await pay('gw:mp-6', 100_000);
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(300_000);
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(250_000);
    });

    it('filial kassasi yo`q → 404, hech narsa yozilmaydi', async () => {
      await expect(
        service.paymentsToMarket({
          market_id: '201',
          amount: 1_000,
          payment_method: PaymentMethod.CASH,
          payer_cashbox_type: Cashbox_type.BRANCH,
          payer_user_id: '99',
          dedup_epoch: 'gw:mp-7',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
      expect(await historyRows()).toHaveLength(0);
    });

    it('HQ yo`li o`zgarmagan: payer berilmasa — MAIN kassadan, bitta siljish', async () => {
      await service.paymentsToMarket({
        market_id: '201',
        amount: 100_000,
        payment_method: PaymentMethod.CASH,
        dedup_epoch: 'gw:mp-8',
      });
      expect((await box('0', Cashbox_type.MAIN)).cash).toBe(900_000);
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(500_000);
      expect(advances()).toEqual([['hq_to_market', '201', 100_000, 'gw:mp-8']]);
    });
  });
});
