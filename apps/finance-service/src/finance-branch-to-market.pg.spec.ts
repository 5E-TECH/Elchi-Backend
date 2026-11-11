import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
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
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxReceipt } from './entities/cashbox-receipt.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { Shift } from './entities/shift.entity';
import { CashboxReceiptService } from './cashbox-receipt/cashbox-receipt.service';
import { FinanceNotificationService } from './notification/finance-notification.service';
import { FinanceRealtimeService } from './realtime/finance-realtime.service';
import { PaymentCorrectionService } from './payment-correction/payment-correction.service';

/**
 * (2026-11-11, Dilshod) «Marketga o'tkazma» FILIALDAN — HQ filial
 * menejeridan pul qabul qilayotganda filial pulni HQ'ga bermay,
 * to'g'ridan-to'g'ri marketga o'tkazgan (`paymentFromBranchToMain`,
 * `payment_method: click_to_market` + `market_id`). Haqiqiy Postgres
 * (`FINANCE_OPERATOR_PG_TEST_URI`): kassa oyoqlari (filial −X karta, MAIN
 * +X/−X, market −X, bitta `transfer_id`), daftar siljishlari (`branch_to_hq`
 * + `hq_to_market`), filial «Kassa qarzga ishlaydi», qo'riqchilar,
 * idempotentlik, chek va T6 tuzatish (rad).
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';
const MARKET = '201';
const SA = { requester_id: '1', requester_roles: ['superadmin'] };

/** RpcException tanasi (toRpcError) yoki boshqa xato — o'zi. */
const errorBody = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RpcException) return error.getError();
    const withBody = error as { getError?: () => unknown };
    return typeof withBody?.getError === 'function'
      ? withBody.getError()
      : error;
  }
  throw new Error('xato kutilgan edi');
};

describePg('Filialdan marketga o`tkazma — haqiqiy Postgres', () => {
  const schema = `spec_b2m_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  let corrections: PaymentCorrectionService;
  let receipts: CashboxReceiptService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  /** branch-service `branch.find_by_id` (filial «Kassa qarzga ishlaydi»). */
  const branch = { send: jest.fn() };
  let branchDebt = false;
  /** identity — market «Kassa qarzga ishlaydi» va bildirishnoma tili. */
  let marketDebt = false;
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.user.find_by_id') {
        return of({
          data: { role: 'market', cashbox_debt_enabled: marketDebt },
        });
      }
      if (pattern.cmd === 'identity.audience.resolve') {
        return of({
          data: {
            items: (payload.user_ids as string[]).map((id) => ({
              id,
              language: 'uz',
            })),
          },
        });
      }
      return of({ data: { id: payload?.id, name: 'Bosh admin' } });
    }),
  };
  let followUp: jest.SpyInstance;
  let notify: jest.SpyInstance;

  beforeAll(async () => {
    process.env.RABBITMQ_GATEWAY_QUEUE = 'gateway_queue';
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
        CashboxCard,
        CashboxReceipt,
        FinancialBalanceHistory,
        FinanceSetting,
        PaymentCorrection,
        Shift,
      ],
      synchronize: true,
    });
    await db.initialize();
    const notifications = new FinanceNotificationService(outbox as never);
    const realtime = new FinanceRealtimeService(outbox as never);
    // Chek (2026-11-12): «Marketga o'tkazma» — «O'tkazma» bilan bir xil
    // `hq_transfer` sozlamasi.
    receipts = new CashboxReceiptService(
      db,
      activityLog as never,
      { send: jest.fn(() => of({})) } as never,
      realtime,
    );
    service = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      identityClient as never,
      outbox as never,
      notifications,
      undefined,
      undefined,
      realtime,
      undefined,
      undefined,
      receipts,
      undefined,
      branch as never,
    );
    jest
      .spyOn(service as any, 'tryPublishAdvanceNow')
      .mockResolvedValue(undefined);
    followUp = jest
      .spyOn(service as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
    notify = jest.spyOn(notifications, 'paymentReceived');
    corrections = new PaymentCorrectionService(
      db,
      service,
      activityLog as never,
      outbox as never,
      identityClient as never,
      notifications,
      realtime,
    );
  }, 30_000);

  afterAll(async () => {
    delete process.env.RABBITMQ_GATEWAY_QUEUE;
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    activityLog.log.mockClear();
    followUp.mockClear();
    notify.mockClear();
    branchDebt = false;
    marketDebt = false;
    branch.send.mockReset();
    branch.send.mockImplementation(() =>
      of({
        statusCode: 200,
        data: {
          id: BRANCH,
          type: 'REGIONAL',
          cashbox_debt_enabled: branchDebt,
        },
      }),
    );
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history, "${schema}".cashboxes,
        "${schema}".financial_balance_history, "${schema}".payment_corrections,
        "${schema}".finance_settings, "${schema}".cashbox_cards,
        "${schema}".cashbox_receipts, "${schema}".shifts
        RESTART IDENTITY CASCADE`,
    );
    await seed('0', Cashbox_type.MAIN, 2_000_000, 500_000);
    // Filial: naqd 4 mln, karta 300 000.
    await seed(BRANCH, Cashbox_type.BRANCH, 4_000_000, 300_000);
    // HQ marketga 1 mln qarz (market kassasi = HQ'ning marketga qarzi).
    await seed(MARKET, Cashbox_type.FOR_MARKET, 1_000_000);
  });

  async function seed(
    user_id: string,
    cashbox_type: Cashbox_type,
    cash = 0,
    card = 0,
  ) {
    return db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id,
        cashbox_type,
        balance: cash + card,
        balance_cash: cash,
        balance_card: card,
      }),
    );
  }

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

  const toMarket = (
    amount: number,
    dedup: string,
    extra: Record<string, unknown> = {},
  ) =>
    service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount,
      payment_method: PaymentMethod.CLICK_TO_MARKET,
      market_id: MARKET,
      created_by: '1',
      dedup_epoch: dedup,
      ...extra,
    }) as Promise<any>;

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

  /** Kompaniya puli: HQ + filial − marketga qarz (marketga to'lov uni o'zgartirmaydi). */
  const companyCash = async () => {
    const all = await db.getRepository(Cashbox).find();
    return all.reduce((sum, row) => {
      const balance = Number(row.balance);
      return row.cashbox_type === Cashbox_type.FOR_MARKET
        ? sum - balance
        : sum + balance;
    }, 0);
  };

  const legs = async () =>
    (
      await db.getRepository(CashboxHistory).find({
        relations: ['cashbox'],
        order: { id: 'ASC' },
      })
    ).map((row) => ({
      id: String(row.id),
      box: row.cashbox.cashbox_type,
      op: row.operation_type,
      source: row.source_type,
      method: row.payment_method,
      amount: Number(row.amount),
      transfer: row.transfer_id,
      source_user: row.source_user_id ? String(row.source_user_id) : null,
    }));

  const assertUntouched = async () => {
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 4_300_000,
      cash: 4_000_000,
      card: 300_000,
    });
    expect(await box('0', Cashbox_type.MAIN)).toEqual({
      balance: 2_500_000,
      cash: 2_000_000,
      card: 500_000,
    });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(
      1_000_000,
    );
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
    expect(advances()).toEqual([]);
    expect(followUp).not.toHaveBeenCalled();
  };

  it('⭐ filial karta −X, MAIN sof 0 (+X/−X), market −X; 4 oyoq bitta transfer_id; 2 siljish; buyurtma sinxroni', async () => {
    const before = await companyCash();

    const res = await toMarket(250_000, 'gw:bm-1', { comment: 'Click' });

    expect(res?.statusCode).toBe(200);
    expect(res?.data?.transfer_id).toEqual(expect.any(String));
    // Filial: naqd tegilmadi, karta −250 000.
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 4_050_000,
      cash: 4_000_000,
      card: 50_000,
    });
    // MAIN: sof 0.
    expect(await box('0', Cashbox_type.MAIN)).toEqual({
      balance: 2_500_000,
      cash: 2_000_000,
      card: 500_000,
    });
    // HQ'ning marketga qarzi −250 000.
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(750_000);
    // Pul kompaniyadan chiqdi, marketga qarz ham shuncha kamaydi.
    expect(await companyCash()).toBe(before);

    const rows = await legs();
    const ctm = PaymentMethod.CLICK_TO_MARKET;
    expect(
      rows.map(({ box, op, source, method, amount, source_user }) => [
        box,
        op,
        source,
        method,
        amount,
        source_user,
      ]),
    ).toEqual([
      [
        Cashbox_type.BRANCH,
        Operation_type.EXPENSE,
        Source_type.BRANCH_TO_MAIN,
        ctm,
        250_000,
        BRANCH,
      ],
      [
        Cashbox_type.MAIN,
        Operation_type.INCOME,
        Source_type.BRANCH_TO_MAIN,
        ctm,
        250_000,
        BRANCH,
      ],
      [
        Cashbox_type.MAIN,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        ctm,
        250_000,
        MARKET,
      ],
      [
        Cashbox_type.FOR_MARKET,
        Operation_type.EXPENSE,
        Source_type.MARKET_PAYMENT,
        ctm,
        250_000,
        MARKET,
      ],
    ]);
    expect(new Set(rows.map((row) => row.transfer))).toEqual(
      new Set([res.data.transfer_id]),
    );

    // Daftar: filialning HQ'ga qarzi, keyin HQ'ning marketga qarzi.
    expect(advances()).toEqual([
      ['branch_to_hq', BRANCH, 250_000, 'gw:bm-1'],
      ['hq_to_market', MARKET, 250_000, 'gw:bm-1:m'],
    ]);
    // Market buyurtmalari to'lov holati sinxroni (paymentsToMarket dagidek).
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: MARKET,
        amount: 250_000,
        pickup_fifo_amount: 0,
        dedup_key: 'gw:bm-1',
      }),
    );
    // Marketga «to'lov keldi».
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'market_payment',
        recipient_id: MARKET,
        amount: 250_000,
        payment_method: ctm,
      }),
      expect.anything(),
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          branch_id: BRANCH,
          market_id: MARKET,
        }),
      }),
    );
  });

  it('«Kassa qarzga ishlaydi» o`chiq — filial kartasida yetmasa 400 (naqd bo`lsa ham), hech narsa yozilmaydi', async () => {
    expect(await errorBody(toMarket(400_000, 'gw:bm-2'))).toMatchObject({
      statusCode: 400,
      message: "Karta hisobida yetarli mablag' yo'q",
    });
    await assertUntouched();
  });

  it('⭐ «Kassa qarzga ishlaydi» yoqiq — filial kartasi minusga, daftarga to`liq summa', async () => {
    branchDebt = true;

    await toMarket(400_000, 'gw:bm-3');

    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 3_900_000,
      cash: 4_000_000,
      card: -100_000,
    });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(600_000);
    expect(advances()).toEqual([
      ['branch_to_hq', BRANCH, 400_000, 'gw:bm-3'],
      ['hq_to_market', MARKET, 400_000, 'gw:bm-3:m'],
    ]);
  });

  it('pul nomli kartada — Asosiy karta (hosila) yetmasa 400, rollback; qarz rejimida o`tadi', async () => {
    const branchBox = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id: BRANCH, cashbox_type: Cashbox_type.BRANCH });
    // Karta bo'lagi 300 000, shundan 250 000 nomli kartada → Asosiy karta 50 000.
    await db.getRepository(CashboxCard).save(
      db.getRepository(CashboxCard).create({
        cashbox_id: String(branchBox.id),
        name: 'Uzcard filial',
        balance: 250_000,
        is_default: false,
        is_active: true,
      }),
    );

    expect(await errorBody(toMarket(100_000, 'gw:bm-named'))).toMatchObject({
      statusCode: 400,
      message:
        "Filialning Asosiy kartasida yetarli mablag' yo'q! Mavjud: 50000 so'm, so'ralgan: 100000 so'm",
    });
    await assertUntouched();
    expect(advances()).toEqual([]);

    await toMarket(50_000, 'gw:bm-named-ok');
    expect((await box(BRANCH, Cashbox_type.BRANCH)).card).toBe(250_000);

    branchDebt = true;
    await toMarket(100_000, 'gw:bm-named-debt');
    expect((await box(BRANCH, Cashbox_type.BRANCH)).card).toBe(150_000);
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(850_000);
  });

  it('marketga qarzdan ortiq (market qarzga ishlamaydi) → 400, rollback', async () => {
    branchDebt = true;
    expect(await errorBody(toMarket(1_200_000, 'gw:bm-4'))).toMatchObject({
      statusCode: 400,
    });
    await assertUntouched();
  });

  it.each([
    ['market_id yo`q', { market_id: undefined }, 400],
    ['card_id bilan', { card_id: '3' }, 400],
    ['branch_card_id bilan', { branch_card_id: '7' }, 400],
    ['market kassasi yo`q', { market_id: '999' }, 404],
  ])('%s → %s, hech narsa yozilmaydi', async (_label, extra, status) => {
    expect(
      await errorBody(toMarket(100_000, `gw:bm-5-${status}`, extra)),
    ).toMatchObject({ statusCode: status });
    await assertUntouched();
  });

  it('naqd / o`tkazmada market_id → 400 (jimgina e`tiborsiz qolmaydi)', async () => {
    for (const method of [PaymentMethod.CASH, PaymentMethod.CLICK]) {
      expect(
        await errorBody(
          toMarket(100_000, `gw:bm-6-${method}`, { payment_method: method }),
        ),
      ).toMatchObject({ statusCode: 400 });
    }
    await assertUntouched();
  });

  // ─── Chek (Dilshod 2026-11-12): «O'tkazma» bilan bir xil `hq_transfer` ───

  const policy = { receipt_policy: { kind: 'branch_to_hq' } };
  const uploadReceipt = async () =>
    (
      (await receipts.createDraft({
        kind: 'branch_to_hq',
        file_key: `cashbox-receipt-${randomUUID()}-receipt.jpg`,
        file_sha256: 'c'.repeat(64),
        mime: 'image/jpeg',
        size_bytes: 1000,
        requester_id: '1',
        requester_roles: ['superadmin'],
      })) as { data: { receipt_id: string } }
    ).data.receipt_id;
  const receiptRow = (id: string) =>
    db.getRepository(CashboxReceipt).findOneByOrFail({ id });

  it('⭐ chek rasmi YOQIQ (sukut): cheksiz → 400 RECEIPT_REQUIRED, hech narsa yozilmaydi', async () => {
    expect(await errorBody(toMarket(100_000, 'gw:bm-7', policy))).toMatchObject(
      { statusCode: 400, code: 'RECEIPT_REQUIRED' },
    );
    await assertUntouched();
  });

  it('⭐ chek bilan → bog`lanadi: history = MAIN INCOME, counter = filial EXPENSE; takrorda asl chek; jurnalda receipt_id', async () => {
    const receiptId = await uploadReceipt();
    const res = await toMarket(100_000, 'gw:bm-8', {
      ...policy,
      receipt_id: receiptId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.receipt).toMatchObject({
      id: receiptId,
      ai_status: 'pending',
    });
    const rows = await legs();
    const mainIncome = rows.find(
      (row) =>
        row.box === Cashbox_type.MAIN && row.op === Operation_type.INCOME,
    );
    const branchExpense = rows.find((row) => row.box === Cashbox_type.BRANCH);
    expect(await receiptRow(receiptId)).toMatchObject({
      state: 'linked',
      history_id: mainIncome?.id,
      counter_history_id: branchExpense?.id,
      payment_method: 'click_to_market',
      entered_amount: 100_000,
      branch_id: BRANCH,
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Cashbox',
        metadata: expect.objectContaining({
          market_id: MARKET,
          receipt_id: receiptId,
        }),
      }),
    );

    const again = await toMarket(100_000, 'gw:bm-8', {
      ...policy,
      receipt_id: receiptId,
    });
    expect(again.data).toMatchObject({
      idempotent: true,
      receipt: { id: receiptId },
    });
    expect(await db.getRepository(CashboxHistory).count()).toBe(4);
  });

  it('chek rasmi O`CHIQ → cheksiz o`tadi, `receipt: null`', async () => {
    await receipts.updateSettings({
      ...SA,
      hq_transfer: { photo_required: false },
    });
    const ok = await toMarket(100_000, 'gw:bm-8b', policy);
    expect(ok?.data).toMatchObject({ receipt: null });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(900_000);
  });

  it('chek xato (boshqa turdagi chek) → 400, butun to`lov rollback', async () => {
    const wrong = (
      (await receipts.createDraft({
        kind: 'manual_expense',
        file_key: `cashbox-receipt-${randomUUID()}-receipt.jpg`,
        file_sha256: 'd'.repeat(64),
        mime: 'image/jpeg',
        size_bytes: 1000,
        requester_id: '1',
        requester_roles: ['superadmin'],
      })) as { data: { receipt_id: string } }
    ).data.receipt_id;
    expect(
      await errorBody(
        toMarket(100_000, 'gw:bm-8c', { ...policy, receipt_id: wrong }),
      ),
    ).toMatchObject({ statusCode: 400, code: 'RECEIPT_KIND_MISMATCH' });
    await assertUntouched();
  });

  it('takroriy so`rov (ayni Idempotency-Key) — pul ham, siljish ham bir marta', async () => {
    await toMarket(250_000, 'gw:bm-9');
    const again = await toMarket(250_000, 'gw:bm-9');

    expect(again?.data).toMatchObject({ idempotent: true });
    expect((await box(BRANCH, Cashbox_type.BRANCH)).card).toBe(50_000);
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(750_000);
    expect(await db.getRepository(CashboxHistory).count()).toBe(4);
    expect(advances()).toHaveLength(2);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('oddiy filial → HQ (naqd / click) o`zgarmagan', async () => {
    await service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount: 1_000_000,
      payment_method: PaymentMethod.CASH,
      created_by: '1',
      dedup_epoch: 'gw:bm-10',
    });
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toMatchObject({
      cash: 3_000_000,
      card: 300_000,
    });
    expect((await box('0', Cashbox_type.MAIN)).cash).toBe(3_000_000);
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(
      1_000_000,
    );
    expect(advances()).toEqual([
      ['branch_to_hq', BRANCH, 1_000_000, 'gw:bm-10'],
    ]);
  });

  it('⭐ T6: to`rt oyoqning hech biri qaytarilmaydi / tuzatilmaydi — 409 NOT_CORRECTABLE, pul joyida', async () => {
    await toMarket(250_000, 'gw:bm-11');
    const snapshot = {
      branch: await box(BRANCH, Cashbox_type.BRANCH),
      main: await box('0', Cashbox_type.MAIN),
      market: await box(MARKET, Cashbox_type.FOR_MARKET),
    };

    for (const leg of await legs()) {
      const base = {
        history_id: leg.id,
        reason: "Xato kiritilgan to'lov",
        idempotency_key: randomUUID(),
        ...SA,
      };
      expect(await errorBody(corrections.reverse(base))).toMatchObject({
        statusCode: 409,
        code: 'NOT_CORRECTABLE',
        reason: 'unsupported_type',
      });
      expect(
        await errorBody(
          corrections.correctAmount({
            ...base,
            idempotency_key: randomUUID(),
            new_amount: 100_000,
          }),
        ),
      ).toMatchObject({ statusCode: 409, code: 'NOT_CORRECTABLE' });
    }

    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual(snapshot.branch);
    expect(await box('0', Cashbox_type.MAIN)).toEqual(snapshot.main);
    expect(await box(MARKET, Cashbox_type.FOR_MARKET)).toEqual(snapshot.market);
    expect(await db.getRepository(CashboxHistory).count()).toBe(4);
    expect(await db.getRepository(PaymentCorrection).count()).toBe(0);
  });
});
