import { randomUUID } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  OutboxEvent,
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
// CI: FINANCE_PG_TEST_URI (o`z sxemasi — umumiy bazada xavfsiz).
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('M4 — menejer orqali marketga to`lov — haqiqiy Postgres', () => {
  const schema = `spec_m4f_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  /**
   * Outbox — haqiqiy `outbox_events` qatori (finance ulush tekshiruvi
   * hali qo'llanmagan `branch_to_market` advance'larini shundan o'qiydi).
   */
  const outbox = {
    enqueue: jest.fn(
      async (
        target: string,
        pattern: string,
        payload: unknown,
        opts?: { manager?: { getRepository: DataSource['getRepository'] } },
      ) => {
        if (opts?.manager) {
          await opts.manager
            .getRepository(OutboxEvent)
            .insert({ target, pattern, payload: payload as object });
        }
      },
    ),
  };
  /** order-service taqlidi: (X, M) ulushi va qo'llangan tokenlar. */
  const orderState = {
    share: 1_000_000,
    applied: new Set<string>(),
    down: false,
  };
  const orderClient = {
    send: jest.fn(
      (pattern: { cmd?: string }, payload: Record<string, unknown>) => {
        if (pattern?.cmd === 'order.settlement.branch_market_share') {
          if (orderState.down) {
            return throwError(() => new Error('order-service down'));
          }
          const pending = Array.isArray(payload?.pending_tokens)
            ? (payload.pending_tokens as string[])
            : [];
          return of({
            statusCode: 200,
            data: {
              in_branch: true,
              share: orderState.share,
              applied_tokens: pending.filter((t) => orderState.applied.has(t)),
            },
          });
        }
        return of({ statusCode: 200, data: {} });
      },
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
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory, OutboxEvent],
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
      orderClient as never,
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
    orderClient.send.mockClear();
    orderState.share = 1_000_000;
    orderState.applied = new Set();
    orderState.down = false;
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history,
        "${schema}".outbox_events,
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
        .spyOn(service as never, 'isMarketCashboxDebtEnabled')
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
        // 63HO6cBU (PR-C) — gateway ulushi (finance o'zi qulf ostida qayta o'qiydi).
        branch_share: orderState.share,
      });

    beforeEach(async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 1_000_000);
      // 63HO6cBU — filial kassasi bitta jami (karta bo'lagi 0).
      await seed('15', Cashbox_type.BRANCH, 300_000, 0);
      await seed('201', Cashbox_type.FOR_MARKET, 450_000);
    });

    it('⭐ naqd: filial kassasi −X, market qarzi −X, HQ tegilmaydi; bitta filial → market bo`g`ini (63HO6cBU)', async () => {
      const before = await companyCash();
      const res = await pay('gw:mp-1', 270_000);

      expect(res?.statusCode).toBe(200);
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 30_000,
        cash: 30_000,
        card: 0,
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

      // 63HO6cBU (PR-C) — bitta bo'g'in: faqat (filial 15, market 201).
      expect(advances()).toEqual([
        ['branch_to_market', '15:201', 270_000, 'gw:mp-1'],
      ]);
    });

    it('63HO6cBU — karta (click) ham filial JAMIdan', async () => {
      await pay('gw:mp-2', 150_000, PaymentMethod.CLICK);
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 150_000,
        cash: 150_000,
        card: 0,
      });
    });

    it('⭐ poyga yo`q: birinchi to`lov daftarga hali tushmagan (outbox) — ikkinchisi ulushdan ayirilgan holda tekshiriladi; ortig`i 400, pul ko`chmaydi', async () => {
      orderState.share = 100_000;
      await pay('gw:race-1', 60_000);
      // Daftar hali qo'llamagan: order-service ulushi hamon 100 000.
      await expect(pay('gw:race-2', 60_000)).rejects.toMatchObject({
        error: {
          statusCode: 400,
          message:
            "Summa filial ulushidan oshmasligi kerak (ulush: 40000 so'm)",
        },
      });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(240_000);
      // Qolgan 40 000 — o'tadi.
      await pay('gw:race-3', 40_000);
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(200_000);
      await expect(pay('gw:race-4', 0.01)).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(advances().map((row) => row[2])).toEqual([60_000, 40_000]);
    });

    it('daftar qo`llagach (ulush kamaydi, token qo`llangan) — ikki marta ayirilmaydi', async () => {
      orderState.share = 100_000;
      await pay('gw:app-1', 60_000);
      // order-service qo'lladi: ulush 40 000, token qo'llangan.
      orderState.share = 40_000;
      orderState.applied.add('gw:app-1');
      await pay('gw:app-2', 40_000);
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(200_000);
    });

    it('⭐ parallel ikki to`lov (ulush 100 000, har biri 60 000) — faqat bittasi o`tadi', async () => {
      orderState.share = 100_000;
      const results = await Promise.allSettled([
        pay('gw:par-1', 60_000),
        pay('gw:par-2', 60_000),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected?.reason).toMatchObject({ error: { statusCode: 400 } });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(240_000);
      expect(advances()).toHaveLength(1);
    });

    it('order-service javob bermasa → 503, pul ko`chmaydi, daftar navbati yo`q', async () => {
      orderState.down = true;
      await expect(pay('gw:down-1', 10_000)).rejects.toMatchObject({
        error: { statusCode: 503 },
      });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(300_000);
      expect(await historyRows()).toHaveLength(0);
      expect(advances()).toEqual([]);
    });

    it('⭐ A1/B1: marketga qarzdan ortiq hech qachon (HQ oldindan to`lagan) — 400, pul ko`chmaydi; qarz doirasida o`tadi', async () => {
      // HQ market qarzini to'lab bo'lgan: FOR_MARKET 0, ulush esa hali bor.
      await db.query(
        `UPDATE "${schema}".cashboxes SET balance = 0, balance_cash = 0 WHERE user_id = '201'`,
      );
      orderState.share = 100_000;
      await expect(pay('gw:debt-1', 100_000)).rejects.toMatchObject({
        error: {
          statusCode: 400,
          message: "To'lov miqdori marketga qarzdan oshib ketdi (qarz: 0 so'm)",
        },
      });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(300_000);
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(0);
      // Qarz 50 000: 60 000 — 400, 50 000 — o'tadi (ulushdan kichik).
      await db.query(
        `UPDATE "${schema}".cashboxes SET balance = 50000, balance_cash = 50000 WHERE user_id = '201'`,
      );
      await expect(pay('gw:debt-2', 60_000)).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      await pay('gw:debt-3', 50_000);
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(0);
      expect(advances()).toEqual([
        ['branch_to_market', '15:201', 50_000, 'gw:debt-3'],
      ]);
    });

    it('⭐ B2: boshida nolli market_id (`0201`) — kanonik `201`: in-flight ayiriladi, ortig`i 400; advance `15:201`', async () => {
      orderState.share = 100_000;
      await pay('gw:b2-1', 60_000);
      await expect(
        service.paymentsToMarket({
          market_id: '0201',
          amount: 60_000,
          payment_method: PaymentMethod.CASH,
          payer_cashbox_type: Cashbox_type.BRANCH,
          payer_user_id: '015',
          created_by: '15001',
          dedup_epoch: 'gw:b2-2',
        }),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(240_000);
      const shareCalls = orderClient.send.mock.calls
        .filter(
          (call) => call[0]?.cmd === 'order.settlement.branch_market_share',
        )
        .map((call) => [call[1].branch_id, call[1].market_id]);
      expect(shareCalls).toEqual([
        ['15', '201'],
        ['15', '201'],
      ]);
      expect(advances()).toEqual([
        ['branch_to_market', '15:201', 60_000, 'gw:b2-1'],
      ]);
    });

    it('B4: yuborilmagan (pending) eski hodisa ham ayiriladi; 200 dan ko`p in-flight — 503', async () => {
      orderState.share = 100_000;
      await db.getRepository(OutboxEvent).insert({
        target: 'ORDER',
        pattern: 'order.settlement.advance',
        payload: {
          level: 'branch_to_market',
          match_value: '15:201',
          amount: 70_000,
          request_id: 'gw:old-1',
        },
        status: 'pending',
        created_at: new Date(Date.now() - 30 * 86_400_000),
      } as never);
      await expect(pay('gw:b4-1', 40_000)).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      await pay('gw:b4-2', 30_000);
      await db.query(
        `INSERT INTO "${schema}".outbox_events (target, pattern, payload, status)
         SELECT 'ORDER', 'order.settlement.advance',
                jsonb_build_object('level', 'branch_to_market', 'match_value', '15:201',
                                   'amount', 0, 'request_id', 'bulk-' || g),
                'sent'
           FROM generate_series(1, 201) g`,
      );
      await expect(pay('gw:b4-3', 0.01)).rejects.toMatchObject({
        error: { statusCode: 503 },
      });
    });

    it('B5: order-service ulushi son emas (null) — 503 (0 deb olinmaydi)', async () => {
      orderClient.send.mockImplementationOnce(() =>
        of({ statusCode: 200, data: { in_branch: true, share: null } }),
      );
      await expect(pay('gw:b5-1', 10)).rejects.toMatchObject({
        error: { statusCode: 503 },
      });
    });

    it('filial kassasida yetmasa → 400 (HQ da pul bo`lsa ham), rollback', async () => {
      await expect(
        pay('gw:mp-3', 300_001, PaymentMethod.CLICK),
      ).rejects.toMatchObject({ error: { statusCode: 400 } });
      await expect(pay('gw:mp-4', 300_001)).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(await box('15', Cashbox_type.BRANCH)).toEqual({
        balance: 300_000,
        cash: 300_000,
        card: 0,
      });
      expect((await box('201', Cashbox_type.FOR_MARKET)).balance).toBe(450_000);
      expect(await historyRows()).toHaveLength(0);
      expect(advances()).toEqual([]);
    });

    it('takroriy so`rov — bir marta; boshqa kalit — yangi to`lov', async () => {
      await pay('gw:mp-5', 100_000);
      const again = await pay('gw:mp-5', 100_000);
      expect(again?.data).toMatchObject({ idempotent: true });
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(200_000);

      await pay('gw:mp-6', 100_000);
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(100_000);
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
      expect((await box('15', Cashbox_type.BRANCH)).cash).toBe(300_000);
      expect(advances()).toEqual([['hq_to_market', '201', 100_000, 'gw:mp-8']]);
    });
  });
});
