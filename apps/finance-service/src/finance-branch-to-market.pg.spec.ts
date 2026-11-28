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
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxReceipt } from './entities/cashbox-receipt.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { CashboxReceiptService } from './cashbox-receipt/cashbox-receipt.service';
import { FinanceNotificationService } from './notification/finance-notification.service';
import { FinanceRealtimeService } from './realtime/finance-realtime.service';
import { PaymentCorrectionService } from './payment-correction/payment-correction.service';
import { ShiftReportService } from './shift-report/shift-report.service';

/**
 * (2026-11-11, Dilshod) «Marketga o'tkazma» FILIALDAN — HQ filial
 * menejeridan pul qabul qilayotganda filial pulni HQ'ga bermay,
 * to'g'ridan-to'g'ri marketga o'tkazgan (`paymentFromBranchToMain`,
 * `payment_method: click_to_market` + `market_id`). Haqiqiy Postgres
 * (`FINANCE_OPERATOR_PG_TEST_URI`): kassa oyoqlari (filial −X karta, MAIN
 * +X/−X, market −X, bitta `transfer_id`), daftar siljishlari (`branch_to_hq`
 * + `hq_to_market`), filial «Kassa qarzga ishlaydi», qo'riqchilar,
 * idempotentlik, chek va T6 (2026-11-26: faqat qaytarish).
 */
// CI: FINANCE_PG_TEST_URI (o`z sxemasi — umumiy bazada xavfsiz).
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';
const MARKET = '201';
/** Filial menejeri (filial smenasini ochadi / yopadi). */
const MANAGER = '15001';
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
        CashboxCardMovement,
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
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
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
    // 63HO6cBU — filial kassasi bitta jami: 300 000 (karta bo'lagi 0).
    await seed(BRANCH, Cashbox_type.BRANCH, 300_000, 0);
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
      balance: 300_000,
      cash: 300_000,
      card: 0,
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

  it('⭐ filial jami −X, MAIN sof 0 (+X/−X), market −X; 4 oyoq bitta transfer_id; 2 siljish; buyurtma sinxroni', async () => {
    const before = await companyCash();

    const res = await toMarket(250_000, 'gw:bm-1', { comment: 'Click' });

    expect(res?.statusCode).toBe(200);
    expect(res?.data?.transfer_id).toEqual(expect.any(String));
    // 63HO6cBU — filial: jami −250 000 (karta bo'lagi yo'q).
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 50_000,
      cash: 50_000,
      card: 0,
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

  it('«Kassa qarzga ishlaydi» o`chiq — filial JAMIdan oshsa 400, hech narsa yozilmaydi', async () => {
    expect(await errorBody(toMarket(400_000, 'gw:bm-2'))).toMatchObject({
      statusCode: 400,
      message: "Filial kassasida yetarli mablag' yo'q",
    });
    await assertUntouched();
  });

  it('⭐ «Kassa qarzga ishlaydi» yoqiq — filial jami minusga, daftarga to`liq summa', async () => {
    branchDebt = true;

    await toMarket(400_000, 'gw:bm-3');

    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: -100_000,
      cash: -100_000,
      card: 0,
    });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(600_000);
    expect(advances()).toEqual([
      ['branch_to_hq', BRANCH, 400_000, 'gw:bm-3'],
      ['hq_to_market', MARKET, 400_000, 'gw:bm-3:m'],
    ]);
  });

  it('63HO6cBU — eski nomli filial kartasi va `branch_card_id` ahamiyatsiz: jami bo`yicha o`tadi', async () => {
    const branchBox = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id: BRANCH, cashbox_type: Cashbox_type.BRANCH });
    const named = await db.getRepository(CashboxCard).save(
      db.getRepository(CashboxCard).create({
        cashbox_id: String(branchBox.id),
        name: 'Uzcard filial',
        balance: 250_000,
        is_default: false,
        is_active: true,
      }),
    );

    const res = await toMarket(300_000, 'gw:bm-named', {
      branch_card_id: String(named.id),
    });
    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 0,
      cash: 0,
      card: 0,
    });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(700_000);
    // Filial kartasi qoldig'iga tegilmaydi (karta ishlatilmaydi).
    expect(
      Number(
        (await db.getRepository(CashboxCard).findOneByOrFail({ id: named.id }))
          .balance,
      ),
    ).toBe(250_000);
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
    expect((await box(BRANCH, Cashbox_type.BRANCH)).balance).toBe(50_000);
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(750_000);
    expect(await db.getRepository(CashboxHistory).count()).toBe(4);
    expect(advances()).toHaveLength(2);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('oddiy filial → HQ (naqd / click) o`zgarmagan', async () => {
    await service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount: 200_000,
      payment_method: PaymentMethod.CASH,
      created_by: '1',
      dedup_epoch: 'gw:bm-10',
    });
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toMatchObject({
      cash: 100_000,
      card: 0,
    });
    expect((await box('0', Cashbox_type.MAIN)).cash).toBe(2_200_000);
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(
      1_000_000,
    );
    expect(advances()).toEqual([['branch_to_hq', BRANCH, 200_000, 'gw:bm-10']]);
  });

  it('⭐ T6 (2026-11-26, ega): istalgan oyoqdan QAYTARILADI — filial +X, MAIN sof 0, market +X; 4 teskari qator; daftar hq_to_market → branch_to_hq; summa tahriri — 409 reverse_only', async () => {
    const before = {
      branch: await box(BRANCH, Cashbox_type.BRANCH),
      main: await box('0', Cashbox_type.MAIN),
      market: await box(MARKET, Cashbox_type.FOR_MARKET),
    };
    await toMarket(250_000, 'gw:bm-11');
    const original = await legs();
    expect(original).toHaveLength(4);

    // Tahrir — hech bir oyoqdan: 409 reverse_only, hech narsa o'zgarmaydi.
    for (const leg of original) {
      expect(
        await errorBody(
          corrections.correctAmount({
            history_id: leg.id,
            reason: "Xato kiritilgan to'lov",
            idempotency_key: randomUUID(),
            new_amount: 100_000,
            ...SA,
          }),
        ),
      ).toMatchObject({
        statusCode: 409,
        code: 'NOT_CORRECTABLE',
        reason: 'reverse_only',
      });
    }
    expect(await db.getRepository(PaymentCorrection).count()).toBe(0);

    // Tafsilot: blok bor, faqat qaytarish (`edit_allowed: false`), yo'nalish C.
    const mainIncome = original.find(
      (leg) =>
        leg.box === Cashbox_type.MAIN && leg.op === Operation_type.INCOME,
    )!;
    const detail: any = await service.findHistoryById(mainIncome.id, {
      include_correctable: true,
    });
    expect(detail.data.correctable).toMatchObject({
      allowed: true,
      edit_allowed: false,
      transfer: {
        kind: 'market_payment',
        variant: 'branch_click_market',
        payment_method: 'click_to_market',
        amount: 250_000,
        receiver: { cashbox_type: 'branch', branch_id: BRANCH },
        courier: null,
        market: { id: MARKET },
      },
    });

    outbox.enqueue.mockClear();
    const res: any = await corrections.reverse({
      history_id: mainIncome.id,
      reason: "Xato kiritilgan to'lov",
      idempotency_key: randomUUID(),
      ...SA,
    });
    expect(res.statusCode).toBe(201);
    expect(res.data.correction).toMatchObject({
      action: 'reverse',
      payment_kind: 'market_payment',
      original_amount: 250_000,
      new_amount: null,
    });

    // Kassalar to'lovdan oldingi holatda (naqd / karta bo'laklari ham).
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual(before.branch);
    expect(await box('0', Cashbox_type.MAIN)).toEqual(before.main);
    expect(await box(MARKET, Cashbox_type.FOR_MARKET)).toEqual(before.market);

    // Har asl oyoqqa bitta teskari qator (asl qatorlar o'zgarmaydi).
    const reversals = await db.getRepository(CashboxHistory).find({
      where: { source_type: Source_type.PAYMENT_REVERSAL },
      relations: ['cashbox'],
    });
    expect(reversals).toHaveLength(4);
    expect(
      reversals.map((row) => String(row.reverses_history_id)).sort(),
    ).toEqual(original.map((leg) => leg.id).sort());
    for (const row of reversals) {
      const leg = original.find(
        (item) => item.id === String(row.reverses_history_id),
      )!;
      expect(row.operation_type).not.toBe(leg.op);
      expect(Number(row.amount)).toBe(250_000);
      expect(row.payment_method).toBe(PaymentMethod.CLICK_TO_MARKET);
    }

    // Daftar orqaga: AVVAL market bo'g'ini, keyin filial → HQ.
    const retreats = outbox.enqueue.mock.calls
      .filter((call) => call[1] === 'order.settlement.retreat')
      .map((call) => {
        const payload = call[2] as Record<string, unknown>;
        return [payload.level, payload.match_value, payload.amount];
      });
    expect(retreats).toEqual([
      ['hq_to_market', MARKET, 250_000],
      ['branch_to_hq', BRANCH, 250_000],
    ]);
    expect(
      outbox.enqueue.mock.calls.filter(
        (call) => call[1] === 'order.settlement.advance',
      ),
    ).toEqual([]);

    // Ikkinchi marta (boshqa oyoqdan ham) — 409 ALREADY_CORRECTED.
    const branchLeg = original.find((leg) => leg.box === Cashbox_type.BRANCH)!;
    expect(
      await errorBody(
        corrections.reverse({
          history_id: branchLeg.id,
          reason: "Xato kiritilgan to'lov",
          idempotency_key: randomUUID(),
          ...SA,
        }),
      ),
    ).toMatchObject({ statusCode: 409, code: 'ALREADY_CORRECTED' });
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual(before.branch);
  });

  it('⭐ T6 (2026-11-28, ega): filial VA asosiy kassa smenasi YOPIQ — superadmin qaytarishi o`tadi (#3609 holati); yopilgan smenalar jamisi o`zgarmaydi; filialning keyingi smenasida «Smenalar orasida»; oddiy amallar darvozasi o`zgarmagan', async () => {
    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'all';
    const before = {
      branch: await box(BRANCH, Cashbox_type.BRANCH),
      main: await box('0', Cashbox_type.MAIN),
      market: await box(MARKET, Cashbox_type.FOR_MARKET),
      company: await companyCash(),
    };
    const mainShift: any = await service.openShift({ opened_by: '1' });
    const branchShift: any = await service.openShift({
      opened_by: MANAGER,
      cashbox_user_id: BRANCH,
    });
    await toMarket(250_000, 'gw:bm-shift');
    const original = await legs();
    expect(original).toHaveLength(4);

    const totals = (shift: Shift) => ({
      status: shift.status,
      total_income_cash: Number(shift.total_income_cash),
      total_expense_cash: Number(shift.total_expense_cash),
      total_income_card: Number(shift.total_income_card),
      total_expense_card: Number(shift.total_expense_card),
      expected_balance_cash: Number(shift.expected_balance_cash),
      expected_balance_card: Number(shift.expected_balance_card),
      discrepancy_cash: Number(shift.discrepancy_cash),
    });
    // Kechqurun ikkala smena yopiladi (sanalgan = kutilgan).
    const mainClosed = totals(
      (
        (await service.closeShift({
          closed_by: '1',
          shift_id: String(mainShift.data.id),
          closing_balance_cash: 2_000_000,
          closing_balance_card: 500_000,
        })) as any
      ).data,
    );
    const branchClosed = totals(
      (
        (await service.closeShift({
          closed_by: MANAGER,
          cashbox_user_id: BRANCH,
          closing_balance_cash: 50_000,
        })) as any
      ).data,
    );
    expect(branchClosed).toMatchObject({
      status: ShiftStatus.CLOSED,
      total_expense_cash: 250_000,
      expected_balance_cash: 50_000,
      discrepancy_cash: 0,
    });
    expect(mainClosed).toMatchObject({
      status: ShiftStatus.CLOSED,
      expected_balance_cash: 2_000_000,
      expected_balance_card: 500_000,
      discrepancy_cash: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Oddiy amallar smenasiz — avvalgidek 400 (darvozalar o'zgarmagan):
    // HQ'ga topshiriq (MAIN smenasi) va filial kassasidan qo'lda chiqim.
    expect(await errorBody(toMarket(10_000, 'gw:bm-shift-2'))).toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/^Smena/),
    });
    await expect(
      service.updateBalance({
        user_id: BRANCH,
        amount: 10_000,
        cashbox_type: Cashbox_type.BRANCH,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.MANUAL_EXPENSE,
        require_open_shift: true,
        created_by: MANAGER,
      }),
    ).rejects.toMatchObject({
      error: {
        statusCode: 400,
        message: expect.stringMatching(/filial kassasida/),
      },
    });
    expect(await legs()).toHaveLength(4);

    // Superadmin qaytarishi (filial oyog'idan) — ikkala smena yopiq, o'tadi.
    const branchLeg = original.find((leg) => leg.box === Cashbox_type.BRANCH)!;
    const res: any = await corrections.reverse({
      history_id: branchLeg.id,
      reason: 'xatolik bo`ldi 2 marta urilgan',
      idempotency_key: randomUUID(),
      ...SA,
    });
    expect(res.statusCode).toBe(201);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual(before.branch);
    expect(await box('0', Cashbox_type.MAIN)).toEqual(before.main);
    expect(await box(MARKET, Cashbox_type.FOR_MARKET)).toEqual(before.market);
    expect(await companyCash()).toBe(before.company);
    for (const row of await db.getRepository(Cashbox).find()) {
      expect(Number(row.balance)).toBeCloseTo(
        Number(row.balance_cash) + Number(row.balance_card),
        2,
      );
    }
    expect(
      await db
        .getRepository(CashboxHistory)
        .count({ where: { source_type: Source_type.PAYMENT_REVERSAL } }),
    ).toBe(4);

    // Yopilgan smenalar — jami va farq o'zgarmagan.
    const reload = (id: unknown) =>
      db.getRepository(Shift).findOneByOrFail({ id: String(id) });
    expect(totals(await reload(mainShift.data.id))).toEqual(mainClosed);
    expect(totals(await reload(branchShift.data.id))).toEqual(branchClosed);

    // Ertalab menejer smenani ochadi: ochilish — jonli jami (300 000), hisobotda
    // «Smenalar orasida»: filialga 250 000 kirim (teskari qator), 1 ta.
    const nextShift: any = await service.openShift({
      opened_by: MANAGER,
      cashbox_user_id: BRANCH,
    });
    expect(Number(nextShift.data.opening_balance_cash)).toBe(300_000);
    const reports = new ShiftReportService(
      db,
      activityLog as never,
      { listForShift: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
    );
    const snapshot = await reports.buildSnapshot(nextShift.data as Shift, 1);
    expect(snapshot.between_shifts).toMatchObject({
      income: 250_000,
      expense: 0,
      count: 1,
    });
  });

  it('T6: oddiy filial → HQ topshirig`i (naqd) — tuzatish bloki yo`q, qaytarib bo`lmaydi', async () => {
    await service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount: 100_000,
      payment_method: PaymentMethod.CASH,
      created_by: '1',
      dedup_epoch: 'gw:bm-plain',
    });
    const rows = await legs();
    expect(rows).toHaveLength(2);
    for (const leg of rows) {
      const detail: any = await service.findHistoryById(leg.id, {
        include_correctable: true,
      });
      expect(detail.data.correctable).toBeNull();
      expect(
        await errorBody(
          corrections.reverse({
            history_id: leg.id,
            reason: "Xato kiritilgan to'lov",
            idempotency_key: randomUUID(),
            ...SA,
          }),
        ),
      ).toMatchObject({
        statusCode: 409,
        code: 'NOT_CORRECTABLE',
        reason: 'unsupported_type',
      });
    }
  });
});
