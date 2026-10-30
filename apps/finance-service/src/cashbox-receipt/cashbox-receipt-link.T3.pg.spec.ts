import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  Cashbox_type,
  PaymentMethod,
} from '@app/common';
import { CashboxReceipts1716000000188 } from '../../../../migrations/1716000000188-CashboxReceipts';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { Shift } from '../entities/shift.entity';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { PaymentCorrection } from '../entities/payment-correction.entity';
import { PaymentCorrectionService } from '../payment-correction/payment-correction.service';
import { CashboxReceiptService } from './cashbox-receipt.service';

/**
 * T3-2 (QlLf33Ma) — chekni qo'lda chiqim / HQ'ga o'tkazmaga bog'lash va
 * tarixda ko'rsatish, HAQIQIY Postgres (FINANCE_T3_PG_TEST_URI bo'lmasa
 * skip; o'z vaqtinchalik bazasi — migratsiya 188 `finance_schema` ga).
 */
const pgUri = process.env.FINANCE_T3_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;
const SA = ['superadmin'];

type Body = { statusCode?: number; code?: string; message?: string };
async function rpcError(promise: Promise<unknown>): Promise<Body> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) return error.getError() as Body;
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

describePg('T3-2 chekni bog`lash — haqiqiy Postgres', () => {
  const dbName = `spec_t3l_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  let receipts: CashboxReceiptService;
  let corrections: PaymentCorrectionService;
  let categoryId = '';
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const entities = [
      Cashbox,
      CashboxHistory,
      CashboxCard,
      CashboxExpenseCategory,
      FinancialBalanceHistory,
      FinanceSetting,
      Shift,
      ActivityLog,
      PaymentCorrection,
    ];
    const bootstrap = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities,
      synchronize: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA finance_schema');
    await bootstrap.synchronize();
    const runner = bootstrap.createQueryRunner();
    await new CashboxReceipts1716000000188().up(runner);
    await runner.release();
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [...entities, CashboxReceipt],
      synchronize: false,
    });
    await db.initialize();
    const activityLog = new ActivityLogService(
      db.getRepository(ActivityLog),
      'finance-service',
    );
    process.env.RABBITMQ_GATEWAY_QUEUE = 'gateway_queue';
    receipts = new CashboxReceiptService(
      db,
      activityLog,
      { send: jest.fn(() => of({})) } as never,
      new FinanceRealtimeService(outbox as never),
    );
    const identityClient = {
      send: jest.fn((_p: { cmd: string }, payload: any) =>
        of({
          data: Array.isArray(payload?.ids)
            ? payload.ids.map((id: string) => ({ id, name: `U-${id}` }))
            : { id: payload?.id, name: 'Bosh admin' },
        }),
      ),
    };
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog,
      { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
      { send: jest.fn(() => of({})) } as never,
      identityClient as never,
      outbox as never,
      new FinanceNotificationService(outbox as never),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      receipts,
    );
    jest
      .spyOn(finance as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
    corrections = new PaymentCorrectionService(
      db,
      finance,
      activityLog,
      outbox as never,
      identityClient as never,
      new FinanceNotificationService(outbox as never),
      new FinanceRealtimeService(outbox as never),
      receipts,
    );
  }, 60_000);

  afterAll(async () => {
    delete process.env.RABBITMQ_GATEWAY_QUEUE;
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    await db.query(
      `TRUNCATE finance_schema.cashbox_history, finance_schema.cashboxes,
        finance_schema.cashbox_receipts, finance_schema.finance_settings,
        finance_schema.cashbox_cards, finance_schema.cashbox_expense_categories,
        finance_schema.financial_balance_history, finance_schema.shifts,
        finance_schema.payment_corrections
        RESTART IDENTITY CASCADE`,
    );
    for (const [user_id, cashbox_type, cash, card] of [
      ['0', Cashbox_type.MAIN, 1_000_000, 1_000_000],
      ['301', Cashbox_type.FOR_COURIER, 500_000, 500_000],
      ['15', Cashbox_type.BRANCH, 400_000, 400_000],
    ] as const) {
      await db.getRepository(Cashbox).save(
        db.getRepository(Cashbox).create({
          user_id,
          cashbox_type,
          balance: cash + card,
          balance_cash: cash,
          balance_card: card,
        }),
      );
    }
    const category = await db
      .getRepository(CashboxExpenseCategory)
      .save(db.getRepository(CashboxExpenseCategory).create({ name: 'Ijara' }));
    categoryId = String(category.id);
  });

  // ───────────────────────── yordamchilar ─────────────────────────

  const upload = async (
    kind: string,
    uploader = '7',
    roles = SA,
    branch?: string,
  ) => {
    const res = (await receipts.createDraft({
      kind,
      file_key: `cashbox-receipt-${randomUUID()}-receipt.jpg`,
      file_sha256: 'b'.repeat(64),
      mime: 'image/jpeg',
      size_bytes: 1000,
      requester_id: uploader,
      requester_roles: roles,
      branch_id: branch,
    })) as { data: { receipt_id: string } };
    return res.data.receipt_id;
  };

  const setSettings = (patch: Record<string, unknown>) =>
    receipts.updateSettings({
      requester_id: '1',
      requester_roles: SA,
      ...patch,
    });

  const spend = (extra: Record<string, unknown> = {}) =>
    finance.spendMoney({
      user_id: '7',
      amount: 120_000,
      type: PaymentMethod.CASH,
      created_by: '7',
      dedup_epoch: `sp-${randomUUID()}`,
      expense_category_id: categoryId,
      financial_ledger: true,
      receipt_policy: { kind: 'manual_expense' },
      ...extra,
    }) as Promise<any>;

  const mainBalance = async () =>
    Number(
      (
        await db
          .getRepository(Cashbox)
          .findOneByOrFail({ user_id: '0', cashbox_type: Cashbox_type.MAIN })
      ).balance,
    );

  const receiptRow = (id: string) =>
    db.getRepository(CashboxReceipt).findOneByOrFail({ id });

  // ───────────────────────── qo'lda chiqim ─────────────────────────

  it('⭐ rasm yoqiq, receipt_id siz → 400 RECEIPT_REQUIRED, pul o`zgarmaydi', async () => {
    const before = await mainBalance();
    await expect(rpcError(spend())).resolves.toMatchObject({
      statusCode: 400,
      code: 'RECEIPT_REQUIRED',
      message: 'Chek rasmini yuklang',
    });
    expect(await mainBalance()).toBe(before);
    expect(await db.getRepository(CashboxHistory).count()).toBe(0);
  });

  it('⭐ rasm o`chiq → 200, receipt = null', async () => {
    await setSettings({ manual_expense: { photo_required: false } });
    const res = await spend();
    expect(res.statusCode).toBe(200);
    expect(res.data.receipt).toBeNull();
  });

  it('ichki chiqim (receipt_policy yo`q) — chek talab qilinmaydi, javobda kalit yo`q', async () => {
    const res = await spend({ receipt_policy: undefined });
    expect(res.statusCode).toBe(200);
    expect(res.data).not.toHaveProperty('receipt');
  });

  it('⭐ chek bilan chiqim → linked, pending (yangi ai_request_id), tarix ID, operatsiya maydonlari', async () => {
    const receiptId = await upload('manual_expense');
    const res = await spend({ receipt_id: receiptId });
    expect(res.statusCode).toBe(200);
    expect(res.data.receipt).toMatchObject({
      id: receiptId,
      kind: 'manual_expense',
      ai_status: 'pending',
    });
    expect(res.data.receipt.ai_request_id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await receiptRow(receiptId);
    expect(row).toMatchObject({
      state: 'linked',
      history_id: String(res.data.history.id),
      counter_history_id: null,
      entered_amount: 120_000,
      payment_method: 'cash',
      linked_by: '7',
      ai_status: 'pending',
      photo_required_snap: true,
      ai_enabled_snap: true,
    });
  });

  it('AI o`chiq (rasm yoqiq) → ai_status disabled, ai_request_id yo`q', async () => {
    await setSettings({ manual_expense: { ai_enabled: false } });
    const receiptId = await upload('manual_expense');
    const res = await spend({ receipt_id: receiptId });
    expect(res.data.receipt).toMatchObject({
      ai_status: 'disabled',
      ai_request_id: null,
    });
  });

  it('rasm o`chirilgandan keyin qoralama yuborilsa — bog`lanadi, disabled', async () => {
    const receiptId = await upload('manual_expense');
    await setSettings({ manual_expense: { photo_required: false } });
    const res = await spend({ receipt_id: receiptId });
    expect(res.data.receipt).toMatchObject({
      id: receiptId,
      ai_status: 'disabled',
    });
  });

  it('⭐ admin A cheki admin B da → 403; ishlatilgan → 409; tur mos emas → 400; yo`q → 400; pul o`zgarmaydi', async () => {
    const before = await mainBalance();
    const a = await upload('manual_expense', '7');
    await expect(
      rpcError(spend({ receipt_id: a, created_by: '8' })),
    ).resolves.toMatchObject({ statusCode: 403, code: 'RECEIPT_NOT_OWNER' });

    await spend({ receipt_id: a });
    const afterFirst = await mainBalance();
    await expect(rpcError(spend({ receipt_id: a }))).resolves.toMatchObject({
      statusCode: 409,
      code: 'RECEIPT_ALREADY_USED',
    });

    const hq = await upload('courier_to_hq', '7');
    await expect(rpcError(spend({ receipt_id: hq }))).resolves.toMatchObject({
      statusCode: 400,
      code: 'RECEIPT_KIND_MISMATCH',
    });
    await expect(
      rpcError(spend({ receipt_id: '999999' })),
    ).resolves.toMatchObject({ statusCode: 400, code: 'RECEIPT_NOT_FOUND' });
    expect(await mainBalance()).toBe(afterFirst);
    expect(afterFirst).toBe(before - 120_000);
  });

  it('⭐ takroriy Idempotency-Key → asl chek, pul bir marta', async () => {
    const receiptId = await upload('manual_expense');
    const token = `sp-${randomUUID()}`;
    const first = await spend({ receipt_id: receiptId, dedup_epoch: token });
    const second = await spend({ receipt_id: receiptId, dedup_epoch: token });
    expect(second.data.idempotent).toBe(true);
    expect(second.data.receipt).toMatchObject({
      id: receiptId,
      ai_status: 'pending',
      ai_request_id: null,
    });
    expect(first.data.receipt.id).toBe(receiptId);
    expect(await db.getRepository(CashboxHistory).count()).toBe(1);
  });

  it('menejer: filial chiqimi — chek branch_id = filial', async () => {
    const receiptId = await upload('manual_expense', '31', ['manager'], '15');
    const res = await spend({
      user_id: '15',
      created_by: '31',
      cashbox_type: Cashbox_type.BRANCH,
      receipt_id: receiptId,
    });
    expect(res.statusCode).toBe(200);
    expect((await receiptRow(receiptId)).branch_id).toBe('15');
  });

  // ───────────────────────── HQ'ga o'tkazma ─────────────────────────

  const payCourier = (extra: Record<string, unknown> = {}) =>
    finance.paymentsFromCourier({
      courier_id: '301',
      amount: 90_000,
      payment_method: PaymentMethod.CLICK,
      created_by: '7',
      dedup_epoch: `pc-${randomUUID()}`,
      receipt_policy: { kind: 'courier_to_hq' },
      ...extra,
    }) as Promise<any>;

  it('⭐ SA HQ kuryeridan click — chek: history = MAIN INCOME, counter = kuryer EXPENSE (transfer_id)', async () => {
    const receiptId = await upload('courier_to_hq');
    const res = await payCourier({ receipt_id: receiptId });
    expect(res.statusCode).toBe(201);
    expect(res.data.receipt).toMatchObject({
      id: receiptId,
      ai_status: 'pending',
    });
    const legs = await db.getRepository(CashboxHistory).find({
      where: { transfer_id: res.data.transfer_id },
      relations: ['cashbox'],
    });
    const income = legs.find(
      (l) => l.cashbox.cashbox_type === Cashbox_type.MAIN,
    );
    const expense = legs.find(
      (l) => l.cashbox.cashbox_type === Cashbox_type.FOR_COURIER,
    );
    const row = await receiptRow(receiptId);
    expect(row).toMatchObject({
      state: 'linked',
      history_id: String(income?.id),
      counter_history_id: String(expense?.id),
      courier_id: '301',
      payment_method: 'click',
      entered_amount: 90_000,
    });
  });

  it('click, rasm yoqiq, cheksiz → 400 RECEIPT_REQUIRED, pul o`zgarmaydi', async () => {
    const before = await mainBalance();
    await expect(rpcError(payCourier())).resolves.toMatchObject({
      code: 'RECEIPT_REQUIRED',
    });
    expect(await mainBalance()).toBe(before);
  });

  it.each([[PaymentMethod.CASH], [PaymentMethod.CLICK_TO_MARKET]])(
    '⭐ %s + receipt_id → 400 RECEIPT_NOT_APPLICABLE; %s cheksiz — o`tadi, receipt null',
    async (method) => {
      const receiptId = await upload('courier_to_hq');
      const extra =
        method === PaymentMethod.CLICK_TO_MARKET ? { market_id: '501' } : {};
      if (method === PaymentMethod.CLICK_TO_MARKET) {
        await db.getRepository(Cashbox).save(
          db.getRepository(Cashbox).create({
            user_id: '501',
            cashbox_type: Cashbox_type.FOR_MARKET,
            // HQ marketga qarzdor (click_to_market chegarasi).
            balance: 500_000,
            balance_cash: 500_000,
            balance_card: 0,
          }),
        );
      }
      await expect(
        rpcError(
          payCourier({
            payment_method: method,
            receipt_id: receiptId,
            ...extra,
          }),
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          statusCode: 400,
          code: 'RECEIPT_NOT_APPLICABLE',
        }),
      );
      if (method === PaymentMethod.CASH) {
        const res = await payCourier({ payment_method: method });
        expect(res.statusCode).toBe(201);
        expect(res.data.receipt).toBeNull();
      }
    },
  );

  it('kuryer to`lovi takrori → asl chek', async () => {
    const receiptId = await upload('courier_to_hq');
    const token = `pc-${randomUUID()}`;
    await payCourier({ receipt_id: receiptId, dedup_epoch: token });
    const again = await payCourier({
      receipt_id: receiptId,
      dedup_epoch: token,
    });
    expect(again.data).toMatchObject({
      idempotent: true,
      receipt: { id: receiptId },
    });
  });

  const branchToMain = (extra: Record<string, unknown> = {}) =>
    finance.paymentFromBranchToMain({
      branch_id: '15',
      amount: 70_000,
      payment_method: PaymentMethod.CLICK,
      created_by: '7',
      dedup_epoch: `bm-${randomUUID()}`,
      receipt_policy: { kind: 'branch_to_hq' },
      ...extra,
    }) as Promise<any>;

  it('⭐ filial → HQ: MAIN va filial qatorlarida BITTA receipt (tarix ro`yxati)', async () => {
    const receiptId = await upload('branch_to_hq');
    const res = await branchToMain({ receipt_id: receiptId });
    expect(res.statusCode).toBe(200);
    expect(res.data.receipt).toMatchObject({ id: receiptId });
    const list = (await finance.findAllHistory({
      page: 0,
      limit: 0,
      include_receipts: true,
    })) as any;
    const withReceipt = list.data.items.filter((item: any) => item.receipt);
    expect(withReceipt).toHaveLength(2);
    expect(new Set(withReceipt.map((item: any) => item.receipt.id))).toEqual(
      new Set([receiptId]),
    );
    expect(withReceipt[0].receipt).toEqual({
      id: receiptId,
      ai_status: 'pending',
    });
    const row = await receiptRow(receiptId);
    expect(row.branch_id).toBe('15');
  });

  it('filial → HQ naqd + chek → 400 NOT_APPLICABLE', async () => {
    const receiptId = await upload('branch_to_hq');
    await expect(
      rpcError(
        branchToMain({
          payment_method: PaymentMethod.CASH,
          receipt_id: receiptId,
        }),
      ),
    ).resolves.toMatchObject({ code: 'RECEIPT_NOT_APPLICABLE' });
  });

  // ───────────────────────── tarix, tafsilot, filtr ─────────────────────────

  it('⭐ /history/:id — to`liq receipt (file_key, uploaded_by, ai_stale, can_reanalyze)', async () => {
    const receiptId = await upload('manual_expense');
    const res = await spend({ receipt_id: receiptId });
    const detail = (await finance.findHistoryById(String(res.data.history.id), {
      include_receipts: true,
    })) as any;
    expect(detail.data.receipt).toMatchObject({
      id: receiptId,
      kind: 'manual_expense',
      history_id: String(res.data.history.id),
      entered_amount: 120_000,
      uploaded_by: { id: '7' },
      ai_status: 'pending',
      ai_stale: false,
      can_reanalyze: false,
      reanalyze_block: 'RECEIPT_AI_PENDING',
      ai: null,
    });
    expect(String(detail.data.receipt.file_key)).toMatch(/^cashbox-receipt-/);

    const direct = (await finance.getReceipt({ id: receiptId })) as any;
    expect(direct.data.id).toBe(receiptId);
  });

  it('⭐ receipt_status filtri: pending / none / disabled; counts ham filtrlanadi; noto`g`ri → 400', async () => {
    const r1 = await upload('manual_expense');
    await spend({ receipt_id: r1 });
    // Kategoriyali, cheksiz qo'lda chiqim (rasm o'chiq paytda) — none.
    await setSettings({ manual_expense: { photo_required: false } });
    const noReceipt = await spend();
    // Kategoriyasiz ichki chiqim — none EMAS.
    await spend({ expense_category_id: undefined, receipt_policy: undefined });
    // Naqd kuryer o'tkazmasi — none EMAS.
    await finance.paymentsFromCourier({
      courier_id: '301',
      amount: 1000,
      payment_method: PaymentMethod.CASH,
      created_by: '7',
      dedup_epoch: `pc-${randomUUID()}`,
    });
    // Cheksiz click kuryer → HQ (rasm o'chiq) — MAIN INCOME none, qarshi
    // EXPENSE — yo'q.
    await setSettings({ hq_transfer: { photo_required: false } });
    const clickNoReceipt = await finance.paymentsFromCourier({
      courier_id: '301',
      amount: 2000,
      payment_method: PaymentMethod.CLICK,
      created_by: '7',
      dedup_epoch: `pc-${randomUUID()}`,
    });

    const find = (receipt_status: string) =>
      finance.findAllHistory({
        page: 0,
        limit: 0,
        receipt_status,
        include_receipts: true,
      }) as Promise<any>;

    const pending = await find('pending');
    expect(pending.data.items.map((i: any) => i.receipt?.id)).toEqual([r1]);
    expect(pending.data.counts).toEqual({ all: 1, income: 0, expense: 1 });

    const none = await find('none');
    const noneIds = none.data.items.map((i: any) => String(i.id)).sort();
    const clickIncome = await db.getRepository(CashboxHistory).findOneOrFail({
      where: {
        transfer_id: (clickNoReceipt as any).data.transfer_id,
        operation_type: 'income' as never,
      },
    });
    expect(noneIds).toEqual(
      [String(noReceipt.data.history.id), String(clickIncome.id)].sort(),
    );
    expect(none.data.counts).toEqual({ all: 2, income: 1, expense: 1 });

    expect((await find('disabled')).data.items).toHaveLength(0);
    await expect(rpcError(find('salary'))).resolves.toMatchObject({
      statusCode: 400,
    });
  });

  // ───────────────────────── AI (T3-3) ─────────────────────────

  const linkedReceipt = async (amount = 145_000) => {
    const receiptId = await upload('manual_expense');
    const res = await spend({ receipt_id: receiptId, amount });
    return {
      receiptId,
      requestId: String(res.data.receipt.ai_request_id),
      historyId: String(res.data.history.id),
    };
  };

  const aiOk = (over: Record<string, unknown> = {}) => ({
    ok: true,
    amount: 150_000,
    currency: 'UZS',
    date: new Date().toISOString().slice(0, 10),
    recipient_name: 'Ijara MChJ',
    recipient_card_last4: null,
    payer_name: null,
    payer_card_last4: null,
    bank: 'Kapitalbank',
    reference: `TX-${randomUUID().slice(0, 8)}`,
    confidence: 0.92,
    model: 'claude-test',
    ...over,
  });

  const realtimeEvents = () =>
    outbox.enqueue.mock.calls
      .map(
        (call: unknown[]) =>
          call[2] as { event?: string; payload?: any; targets?: any[] },
      )
      .filter((msg) => msg?.event === 'finance.receipt.checked');

  it('⭐ AI: 150 000 vs 145 000 → mismatch, difference +5 000, attempts 1, realtime (summasiz) + jurnal', async () => {
    const { receiptId, requestId, historyId } = await linkedReceipt();
    outbox.enqueue.mockClear();
    const res = (await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: requestId,
      result: aiOk(),
    })) as any;
    expect(res.data).toEqual({ receipt_id: receiptId, ai_status: 'mismatch' });
    const row = await receiptRow(receiptId);
    expect(row).toMatchObject({
      ai_status: 'mismatch',
      ai_amount: 150_000,
      ai_difference: 5_000,
      ai_attempts: 1,
      ai_currency: 'UZS',
      ai_bank: 'Kapitalbank',
      ai_flags: [],
    });
    const [event] = realtimeEvents();
    expect(event.payload).toMatchObject({
      receipt_id: receiptId,
      history_id: historyId,
      kind: 'manual_expense',
      ai_status: 'mismatch',
    });
    expect(JSON.stringify(event)).not.toContain('150000');
    expect(event.targets).toEqual(
      expect.arrayContaining([
        { role: 'superadmin' },
        { role: 'admin' },
        { user_id: '7' },
      ]),
    );
    const logs = await db.getRepository(ActivityLog).find({
      where: { action: 'finance.receipt_ai_checked' } as never,
    });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toMatch(/Ijara|Kapitalbank|TX-/);

    const detail = (await finance.findHistoryById(historyId, {
      include_receipts: true,
    })) as any;
    expect(detail.data.receipt).toMatchObject({
      ai_status: 'mismatch',
      can_reanalyze: true,
      ai: { amount: 150_000, difference: 5_000, attempts: 1, max_attempts: 5 },
    });
  });

  it('eski ai_request_id natijasi e`tiborsiz; xato → error (attempts +1)', async () => {
    const { receiptId, requestId } = await linkedReceipt();
    const stale = (await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: randomUUID(),
      result: aiOk({ amount: 145_000 }),
    })) as any;
    expect(stale.data).toEqual({ ignored: true });
    expect((await receiptRow(receiptId)).ai_status).toBe('pending');

    await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: requestId,
      result: { ok: false, reason: 'network' },
    });
    expect(await receiptRow(receiptId)).toMatchObject({
      ai_status: 'error',
      ai_error_reason: 'network',
      ai_attempts: 1,
    });
  });

  it('⭐ bir rasm ikki chekda → duplicate_photo; o`sha referens → duplicate_reference', async () => {
    const first = await linkedReceipt(150_000);
    await receipts.applyAiResult({
      receipt_id: first.receiptId,
      ai_request_id: first.requestId,
      result: aiOk({ reference: 'TX-SAME' }),
    });
    const second = await linkedReceipt(150_000);
    await receipts.applyAiResult({
      receipt_id: second.receiptId,
      ai_request_id: second.requestId,
      result: aiOk({ reference: 'TX-SAME' }),
    });
    expect(await receiptRow(second.receiptId)).toMatchObject({
      ai_status: 'match',
      ai_flags: ['duplicate_photo', 'duplicate_reference'],
    });
  });

  it('⭐ qayta tahlil: mismatch → 202 pending (yangi request_id); match → 409; disabled → 400; urinishlar 5 → 429; menejer → 403', async () => {
    const { receiptId, requestId } = await linkedReceipt();
    await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: requestId,
      result: aiOk(),
    });
    const res = (await receipts.requestReanalyze({
      receipt_id: receiptId,
      requester_id: '1',
      requester_roles: SA,
    })) as any;
    expect(res).toMatchObject({
      statusCode: 202,
      data: { receipt_id: receiptId, ai_status: 'pending' },
    });
    expect(res.data.ai_request_id).not.toBe(requestId);
    expect(String(res.data.file_key)).toMatch(/^cashbox-receipt-/);
    // Ikkinchi so'rov — tahlil davom etmoqda.
    await expect(
      rpcError(
        receipts.requestReanalyze({
          receipt_id: receiptId,
          requester_roles: SA,
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 409, code: 'RECEIPT_AI_PENDING' });
    // Yangi natija — match → qayta tahlil yo'q.
    await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: res.data.ai_request_id,
      result: aiOk({ amount: 145_000 }),
    });
    expect((await receiptRow(receiptId)).ai_attempts).toBe(2);
    await expect(
      rpcError(
        receipts.requestReanalyze({
          receipt_id: receiptId,
          requester_roles: SA,
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'RECEIPT_ALREADY_MATCHED',
    });
    await expect(
      rpcError(
        receipts.requestReanalyze({
          receipt_id: receiptId,
          requester_roles: ['manager'],
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });

    // Urinishlar tugagan.
    await db.query(
      `UPDATE finance_schema.cashbox_receipts SET ai_status = 'error', ai_attempts = 5 WHERE id = $1`,
      [receiptId],
    );
    await expect(
      rpcError(
        receipts.requestReanalyze({
          receipt_id: receiptId,
          requester_roles: SA,
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 429,
      code: 'RECEIPT_AI_ATTEMPTS_EXHAUSTED',
    });

    // AI o'chirildi → disabled emas, lekin joriy sozlamada o'chiq → 400.
    await db.query(
      `UPDATE finance_schema.cashbox_receipts SET ai_attempts = 1 WHERE id = $1`,
      [receiptId],
    );
    await setSettings({ manual_expense: { ai_enabled: false } });
    await expect(
      rpcError(
        receipts.requestReanalyze({
          receipt_id: receiptId,
          requester_roles: SA,
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400, code: 'RECEIPT_AI_DISABLED' });
  });

  it('3 daqiqadan oshgan pending — ai_stale, qayta tahlil ruxsat', async () => {
    const { receiptId, historyId } = await linkedReceipt();
    await db.query(
      `UPDATE finance_schema.cashbox_receipts
          SET ai_requested_at = now() - interval '4 minutes' WHERE id = $1`,
      [receiptId],
    );
    const detail = (await finance.findHistoryById(historyId, {
      include_receipts: true,
    })) as any;
    expect(detail.data.receipt).toMatchObject({
      ai_status: 'pending',
      ai_stale: true,
      can_reanalyze: true,
    });
    await expect(
      receipts.requestReanalyze({ receipt_id: receiptId, requester_roles: SA }),
    ).resolves.toMatchObject({ statusCode: 202 });
  });

  // ───────────────────────── xulosa (T3-4) ─────────────────────────

  const summary = (extra: Record<string, unknown> = {}) =>
    receipts.summary({ requester_roles: SA, ...extra }) as Promise<any>;

  const checked = async (entered: number, read: number) => {
    const r = await linkedReceipt(entered);
    await receipts.applyAiResult({
      receipt_id: r.receiptId,
      ai_request_id: r.requestId,
      result: aiOk({ amount: read }),
    });
    return r;
  };

  it('⭐ xulosa: 3 match, 2 mismatch (+5 000, −2 000), 1 cheksiz → none 1, mismatch_total 7 000; none = tarix filtri', async () => {
    for (const amount of [100_000, 110_000, 120_000]) {
      await checked(amount, amount);
    }
    const plus = await checked(145_000, 150_000);
    const minus = await checked(52_000, 50_000);
    await setSettings({ manual_expense: { photo_required: false } });
    await spend();
    // Kategoriyasiz ichki chiqim — hisobga kirmaydi.
    await spend({ expense_category_id: undefined, receipt_policy: undefined });

    const res = await summary();
    expect(res.statusCode).toBe(200);
    expect(res.data.counts).toEqual({
      match: 3,
      mismatch: 2,
      unreadable: 0,
      pending: 0,
      error: 0,
      disabled: 0,
      none: 1,
    });
    expect(res.data.total).toBe(6);
    expect(res.data.mismatch_total).toBe(7_000);
    expect(res.data.top.map((t: any) => [t.receipt_id, t.difference])).toEqual([
      [plus.receiptId, 5_000],
      [minus.receiptId, -2_000],
    ]);
    expect(res.data.top[0]).toMatchObject({
      history_id: plus.historyId,
      kind: 'manual_expense',
      entered_amount: 145_000,
    });
    expect(res.data.by_category).toEqual([
      {
        expense_category_id: categoryId,
        name: 'Ijara',
        counts: expect.objectContaining({ match: 3, mismatch: 2, none: 1 }),
      },
    ]);
    expect(res.data.by_branch).toEqual([]);
    // Ism, rasm havolasi, karta yo'q.
    expect(JSON.stringify(res.data)).not.toMatch(
      /file_key|photo|cashbox-receipt-|last4|U-7|Kapitalbank/,
    );

    const history = (await finance.findAllHistory({
      page: 0,
      limit: 0,
      receipt_status: 'none',
    })) as any;
    expect(history.data.counts.all).toBe(res.data.counts.none);

    const onlyMismatch = await summary({ ai_status: 'mismatch' });
    expect(onlyMismatch.data.counts).toMatchObject({
      match: 0,
      mismatch: 2,
      none: 0,
    });
    const hqOnly = await summary({ kind: 'courier_to_hq' });
    expect(hqOnly.data.total).toBe(0);
  });

  it('xulosa: filial → HQ cheki va cheksiz click o`tkazma by_branch da; davr tashqarisi kirmaydi', async () => {
    const receiptId = await upload('branch_to_hq');
    await branchToMain({ receipt_id: receiptId });
    await setSettings({ hq_transfer: { photo_required: false } });
    await branchToMain();
    const res = await summary({ kind: 'branch_to_hq' });
    expect(res.data.counts).toMatchObject({ pending: 1, none: 1 });
    expect(res.data.by_branch).toEqual([
      {
        branch_id: '15',
        counts: expect.objectContaining({ pending: 1, none: 1 }),
      },
    ]);
    const past = await summary({ from: '2020-01-01', to: '2020-01-31' });
    expect(past.data.total).toBe(0);
    expect(past.data.period).toEqual({ from: '2020-01-01', to: '2020-01-31' });
  });

  it('xulosa: menejer → 403; davr > 366 kun, noto`g`ri sana / kind / ai_status → 400', async () => {
    await expect(
      rpcError(receipts.summary({ requester_roles: ['manager'] })),
    ).resolves.toMatchObject({ statusCode: 403 });
    for (const bad of [
      { from: '2024-01-01', to: '2025-06-01' },
      { from: '2025-02-30' },
      { from: '2025-03-02', to: '2025-03-01' },
      { kind: 'salary' },
      { ai_status: 'linked' },
    ]) {
      await expect(rpcError(summary(bad))).resolves.toMatchObject({
        statusCode: 400,
      });
    }
  });

  // ───────────────────────── #596 ko'rib chiqish ─────────────────────────

  const courierLegs = async (transferId: string) => {
    const legs = await db.getRepository(CashboxHistory).find({
      where: { transfer_id: transferId },
      relations: ['cashbox'],
    });
    return {
      income: legs.find((l) => l.cashbox.cashbox_type === Cashbox_type.MAIN)!,
      expense: legs.find(
        (l) => l.cashbox.cashbox_type === Cashbox_type.FOR_COURIER,
      )!,
    };
  };

  const noneTotal = async () =>
    (
      (await finance.findAllHistory({
        page: 0,
        limit: 0,
        receipt_status: 'none',
        include_receipts: true,
      })) as any
    ).data.counts.all as number;

  it('⭐ fail closed: include_receipts siz — receipt kaliti yo`q; kuryer kassasida (my-cashbox) hech qachon', async () => {
    const receiptId = await upload('courier_to_hq');
    await payCourier({ receipt_id: receiptId });
    const plain = (await finance.findAllHistory({ page: 0, limit: 0 })) as any;
    expect(plain.data.items.length).toBeGreaterThan(0);
    for (const item of plain.data.items) {
      expect(item).not.toHaveProperty('receipt');
    }
    const mine = (await finance.myCashbox({
      user_id: '301',
      roles: ['courier'],
    })) as any;
    expect(mine.data.cashboxHistory.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine.data)).not.toContain('"receipt"');
    const byId = (await finance.getCashboxByUserId({
      id: '301',
      cashbox_type: Cashbox_type.FOR_COURIER,
      include_receipts: true,
    })) as any;
    expect(JSON.stringify(byId.data)).not.toContain('"receipt"');
  });

  it('⭐ T6 summa tuzatildi: chek yangi oyoqqa ko`chadi, holat yangi summa bilan; none ga tushmaydi', async () => {
    const receiptId = await upload('courier_to_hq');
    const res = await payCourier({ receipt_id: receiptId });
    const requestId = String(res.data.receipt.ai_request_id);
    await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: requestId,
      result: aiOk({ amount: 95_000 }),
    });
    expect((await receiptRow(receiptId)).ai_status).toBe('mismatch');
    const before = await summary();
    expect(before.data.counts).toMatchObject({ mismatch: 1, none: 0 });

    const original = await courierLegs(res.data.transfer_id);
    const fixed = (await corrections.correctAmount({
      history_id: String(original.income.id),
      new_amount: 95_000,
      reason: 'Summa noto`g`ri yozilgan',
      idempotency_key: randomUUID(),
      requester_id: '1',
      requester_roles: SA,
    })) as any;
    expect(fixed.statusCode).toBe(201);
    const moved = await receiptRow(receiptId);
    const newMain = await db
      .getRepository(CashboxHistory)
      .findOneByOrFail({ id: String(moved.history_id) });
    expect(newMain.transfer_id).not.toBe(res.data.transfer_id);
    const replacement = await courierLegs(String(newMain.transfer_id));
    expect(moved).toMatchObject({
      state: 'linked',
      history_id: String(replacement.income.id),
      counter_history_id: String(replacement.expense.id),
      entered_amount: 95_000,
      ai_status: 'match',
      ai_difference: 0,
    });
    expect(Number(replacement.income.amount)).toBe(95_000);
    const after = await summary();
    expect(after.data.counts).toMatchObject({
      match: 1,
      mismatch: 0,
      none: 0,
    });
    expect(after.data.total).toBe(1);
    expect(after.data.mismatch_total).toBe(0);
    expect(await noneTotal()).toBe(0);
  });

  it('T6 qaytarildi (cheksiz click) — qaytarilgan oyoq none dan chiqadi', async () => {
    await setSettings({ hq_transfer: { photo_required: false } });
    const res = await payCourier();
    expect(await noneTotal()).toBe(1);
    const legs = await courierLegs(res.data.transfer_id);
    const reversed = (await corrections.reverse({
      history_id: String(legs.income.id),
      reason: "Xato kiritilgan to'lov",
      idempotency_key: randomUUID(),
      requester_id: '1',
      requester_roles: SA,
    })) as any;
    expect(reversed.statusCode).toBe(201);
    expect(await noneTotal()).toBe(0);
    expect((await summary()).data.counts.none).toBe(0);
  });

  it('muddati o`tgan qoralama — qulfsiz rad (RECEIPT_NOT_FOUND), pul o`zgarmaydi', async () => {
    const receiptId = await upload('manual_expense');
    await db.query(
      `UPDATE finance_schema.cashbox_receipts
          SET uploaded_at = now() - interval '25 hours' WHERE id = $1`,
      [receiptId],
    );
    const before = await mainBalance();
    await expect(
      rpcError(spend({ receipt_id: receiptId })),
    ).resolves.toMatchObject({ statusCode: 400, code: 'RECEIPT_NOT_FOUND' });
    expect(await mainBalance()).toBe(before);
  });

  it('xulosa by_branch: menejerning cheksiz qo`lda chiqimi filial kassasidan', async () => {
    await setSettings({ manual_expense: { photo_required: false } });
    await spend({
      user_id: '15',
      created_by: '31',
      cashbox_type: Cashbox_type.BRANCH,
    });
    const res = await summary();
    expect(res.data.counts.none).toBe(1);
    expect(res.data.by_branch).toEqual([
      { branch_id: '15', counts: expect.objectContaining({ none: 1 }) },
    ]);
  });

  it('duplicate_photo — faqat BIRIKTIRILGAN cheklar; shu rasmli qoralama sanalmaydi', async () => {
    // upload() har doim bir xil sha256 — qoralama qoladi.
    await upload('manual_expense');
    const first = await linkedReceipt(150_000);
    await receipts.applyAiResult({
      receipt_id: first.receiptId,
      ai_request_id: first.requestId,
      result: aiOk(),
    });
    expect((await receiptRow(first.receiptId)).ai_flags).toEqual([]);
  });

  // ───────────────────────── #598 ko'rib chiqish ─────────────────────────

  const reverseCourier = async (transferId: string) => {
    const legs = await courierLegs(transferId);
    const res = (await corrections.reverse({
      history_id: String(legs.income.id),
      reason: "Xato kiritilgan to'lov",
      idempotency_key: randomUUID(),
      requester_id: '1',
      requester_roles: SA,
    })) as any;
    expect(res.statusCode).toBe(201);
  };

  const historyCount = async (receipt_status: string) =>
    (
      (await finance.findAllHistory({
        page: 0,
        limit: 0,
        receipt_status,
        include_receipts: true,
      })) as any
    ).data.counts.all as number;

  it('⭐ mismatch to`lov T6 bilan qaytarildi — summary.mismatch = tarix filtri (0)', async () => {
    const receiptId = await upload('courier_to_hq');
    const res = await payCourier({ receipt_id: receiptId });
    await receipts.applyAiResult({
      receipt_id: receiptId,
      ai_request_id: String(res.data.receipt.ai_request_id),
      result: aiOk({ amount: 95_000 }),
    });
    expect(await historyCount('mismatch')).toBe(2);
    await reverseCourier(res.data.transfer_id);
    const sum = await summary();
    expect(sum.data.counts.mismatch).toBe(0);
    expect(await historyCount('mismatch')).toBe(sum.data.counts.mismatch);
  });

  it('⭐ qaytarilgan to`lovdagi chek — shu skrinshot bilan qayta kiritish duplicate_photo / duplicate_reference EMAS', async () => {
    const first = await upload('courier_to_hq');
    const res = await payCourier({ receipt_id: first });
    await receipts.applyAiResult({
      receipt_id: first,
      ai_request_id: String(res.data.receipt.ai_request_id),
      result: aiOk({ amount: 90_000, reference: 'RRN430512345678' }),
    });
    await reverseCourier(res.data.transfer_id);
    // upload() — o'sha sha256 (o'sha rasm).
    const again = await upload('courier_to_hq');
    const res2 = await payCourier({ receipt_id: again });
    await receipts.applyAiResult({
      receipt_id: again,
      ai_request_id: String(res2.data.receipt.ai_request_id),
      result: aiOk({ amount: 90_000, reference: 'RRN430512345678' }),
    });
    expect((await receiptRow(again)).ai_flags).toEqual([]);
  });

  it('niqoblangan (`*`) referens solishtirilmaydi — soxta duplicate_reference yo`q', async () => {
    const a = await linkedReceipt(150_000);
    await receipts.applyAiResult({
      receipt_id: a.receiptId,
      ai_request_id: a.requestId,
      result: aiOk({ reference: 'TX***' }),
    });
    await db.query(
      `UPDATE finance_schema.cashbox_receipts SET file_sha256 = $2 WHERE id = $1`,
      [a.receiptId, 'c'.repeat(64)],
    );
    const b = await linkedReceipt(150_000);
    await receipts.applyAiResult({
      receipt_id: b.receiptId,
      ai_request_id: b.requestId,
      result: aiOk({ reference: 'TX***' }),
    });
    expect((await receiptRow(b.receiptId)).ai_flags).toEqual([]);
  });

  it('⭐ NOWAIT: chek boshqa tranzaksiyada qulflangan — spend darhol 409 RECEIPT_ALREADY_USED, MAIN o`zgarmaydi', async () => {
    const receiptId = await upload('manual_expense');
    const before = await mainBalance();
    const holder = db.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    try {
      await holder.query(
        `SELECT id FROM finance_schema.cashbox_receipts WHERE id = $1 FOR UPDATE`,
        [receiptId],
      );
      const started = Date.now();
      await expect(
        rpcError(spend({ receipt_id: receiptId })),
      ).resolves.toMatchObject({
        statusCode: 409,
        code: 'RECEIPT_ALREADY_USED',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }
    expect(await mainBalance()).toBe(before);
    expect((await receiptRow(receiptId)).state).toBe('draft');
  });
});
