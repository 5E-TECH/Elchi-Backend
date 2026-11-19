import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Cashbox_type, Operation_type, PaymentMethod } from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { CashboxReceipt } from './entities/cashbox-receipt.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { Shift } from './entities/shift.entity';
import { CashboxReceiptService } from './cashbox-receipt/cashbox-receipt.service';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { FinanceNotificationService } from './notification/finance-notification.service';
import { FinanceRealtimeService } from './realtime/finance-realtime.service';
import { PaymentCorrectionService } from './payment-correction/payment-correction.service';

/**
 * 63HO6cBU (P0, ega qarori 2026-11-17) — FILIAL kassasi naqd va kartaga
 * AJRALMAYDI (bitta jami). Haqiqiy Postgres (`FINANCE_OPERATOR_PG_TEST_URI`):
 *
 *  • menejer kuryerdan usulsiz / naqd / (eski FE) `click` + karta bilan
 *    qabul qiladi → filial jami +X, `balance_card` doim 0;
 *  • admin filialdan «O'tkazma» (`click`) bilan oladi → 200: MAIN
 *    `balance_card` +X (tanlangan HQ kartasiga), filial jami −X, tarixda
 *    `click`; eski FE `branch_card_id` — e'tiborsiz;
 *  • X > jami (qarz o'chiq) → 400; «Kassa qarzga ishlaydi» → ruxsat;
 *  • «Naqd» va «Marketga o'tkazma» yo'llari;
 *  • T6 qaytarish va summa tuzatish BRANCH'da (jami bo'yicha);
 *  • filial smenasi: bitta «Sanalgan summa»;
 *  • filial kartalari: yangi karta / o'tkazma / konvertatsiya → 400.
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';
const MARKET = '201';
const COURIER = '301';
const SA = { requester_id: '1', requester_roles: ['superadmin'] };

const errorBody = async (promise: Promise<unknown>): Promise<any> => {
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

describePg('63HO6cBU — filial kassasi bitta jami (haqiqiy Postgres)', () => {
  const schema = `spec_bsingle_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: FinanceServiceService;
  let corrections: PaymentCorrectionService;
  let cards: CashboxCardService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const branch = { send: jest.fn() };
  let branchDebt = false;
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.user.find_by_id') {
        return of({ data: { role: 'market', cashbox_debt_enabled: false } });
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
      return of({ data: { id: payload?.id, name: 'Xodim' } });
    }),
  };

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
    const receipts = new CashboxReceiptService(
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
    jest
      .spyOn(service as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
    corrections = new PaymentCorrectionService(
      db,
      service,
      activityLog as never,
      outbox as never,
      identityClient as never,
      notifications,
      realtime,
    );
    cards = new CashboxCardService(db, activityLog as never, realtime);
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
    branchDebt = false;
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
        "${schema}".cashbox_card_movements,
        "${schema}".cashbox_receipts, "${schema}".shifts
        RESTART IDENTITY CASCADE`,
    );
    await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
    // Filial: jami 0 (karta bo'lagi ham 0) — muammoning aynan holati.
    await seed(BRANCH, Cashbox_type.BRANCH, 0, 0);
    await seed(COURIER, Cashbox_type.FOR_COURIER, 2_000_000, 0);
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

  const mainCard = async (name: string) =>
    db.getRepository(CashboxCard).save(
      db.getRepository(CashboxCard).create({
        cashbox_id: String(
          (
            await db.getRepository(Cashbox).findOneByOrFail({
              user_id: '0',
              cashbox_type: Cashbox_type.MAIN,
            })
          ).id,
        ),
        name,
        balance: 0,
        is_default: false,
        is_active: true,
      }),
    );

  /** Gateway menejer yo'li: usul server tomonidan `cash`, filial qabul qiladi. */
  const managerReceives = (
    amount: number,
    extra: Record<string, unknown> = {},
  ) =>
    service.paymentsFromCourier({
      courier_id: COURIER,
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: '8',
      dedup_epoch: `gw:${randomUUID()}`,
      receiver_user_id: BRANCH,
      receiver_cashbox_type: Cashbox_type.BRANCH,
      ...extra,
    }) as Promise<any>;

  const adminTakes = (
    amount: number,
    method: PaymentMethod,
    extra: Record<string, unknown> = {},
  ) =>
    service.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount,
      payment_method: method,
      created_by: '1',
      dedup_epoch: `gw:${randomUUID()}`,
      ...extra,
    }) as Promise<any>;

  const branchLegs = async () =>
    (
      await db.getRepository(CashboxHistory).find({
        relations: ['cashbox'],
        order: { id: 'ASC' },
      })
    ).filter((row) => row.cashbox.cashbox_type === Cashbox_type.BRANCH);

  const assertInvariant = async () => {
    for (const cb of await db.getRepository(Cashbox).find()) {
      expect(Number(cb.balance)).toBeCloseTo(
        Number(cb.balance_cash) + Number(cb.balance_card),
        2,
      );
      if (cb.cashbox_type === Cashbox_type.BRANCH) {
        expect(Number(cb.balance_card)).toBe(0);
      }
    }
  };

  it('⭐ P0: menejer naqd qabul qiladi → admin «O`tkazma» (HQ kartasi) bilan oladi → 200; MAIN karta +X, filial jami −X, tarixda click', async () => {
    const card = await mainCard('HQ Uzcard');
    await managerReceives(700_000);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 700_000,
      cash: 700_000,
      card: 0,
    });

    const res = await adminTakes(500_000, PaymentMethod.CLICK, {
      card_id: String(card.id),
    });

    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 200_000,
      cash: 200_000,
      card: 0,
    });
    expect(await box('0', Cashbox_type.MAIN)).toEqual({
      balance: 1_500_000,
      cash: 1_000_000,
      card: 500_000,
    });
    expect(
      Number(
        (await db.getRepository(CashboxCard).findOneByOrFail({ id: card.id }))
          .balance,
      ),
    ).toBe(500_000);
    const legs = await db.getRepository(CashboxHistory).find({
      where: { source_type: 'branch_to_main' as never },
      relations: ['cashbox'],
      order: { id: 'ASC' },
    });
    expect(
      legs.map((l) => [
        l.cashbox.cashbox_type,
        l.operation_type,
        l.payment_method,
      ]),
    ).toEqual([
      [Cashbox_type.BRANCH, Operation_type.EXPENSE, PaymentMethod.CLICK],
      [Cashbox_type.MAIN, Operation_type.INCOME, PaymentMethod.CLICK],
    ]);
    expect(legs[0].card_id).toBeNull();
    expect(String(legs[1].card_id)).toBe(String(card.id));
    await assertInvariant();
  });

  it('eski FE: menejer `click` + karta yuborgan (gateway cash qiladi) — finance BRANCH kartasini e`tiborsiz qoldiradi', async () => {
    // Gateway bo'lmasa ham (to'g'ridan-to'g'ri RMQ): click + card_id → jami.
    await managerReceives(300_000, {
      payment_method: PaymentMethod.CLICK,
      card_id: '999',
    });
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 300_000,
      cash: 300_000,
      card: 0,
    });
    const [leg] = await branchLegs();
    expect(leg.card_id).toBeNull();
    // Admin «O'tkazma» bilan oladi, eski FE `branch_card_id` ham yuboradi.
    const res = await adminTakes(300_000, PaymentMethod.CLICK, {
      branch_card_id: '12345',
    });
    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 0,
      cash: 0,
      card: 0,
    });
    expect((await box('0', Cashbox_type.MAIN)).card).toBe(300_000);
    await assertInvariant();
  });

  it('tarix: filial oyog`i va kuryer→filial qatori `branch_leg: true` (gateway menejer/kuryerga usulni yashiradi); MAIN qatori — yo`q', async () => {
    await managerReceives(200_000);
    await adminTakes(100_000, PaymentMethod.CLICK);

    const courierView: any = await service.findAllHistory({
      user_id: COURIER,
      cashbox_type: Cashbox_type.FOR_COURIER,
    });
    expect(courierView.data.items).toHaveLength(1);
    expect(courierView.data.items[0]).toMatchObject({ branch_leg: true });

    const branchView: any = await service.findAllHistory({
      user_id: BRANCH,
      cashbox_type: Cashbox_type.BRANCH,
    });
    expect(branchView.data.items).toHaveLength(2);
    for (const row of branchView.data.items) {
      expect(row.branch_leg).toBe(true);
    }

    const mainView: any = await service.findAllHistory({
      cashbox_type: Cashbox_type.MAIN,
    });
    expect(mainView.data.items).toHaveLength(1);
    expect(mainView.data.items[0].branch_leg).toBeUndefined();
    expect(mainView.data.items[0].payment_method).toBe(PaymentMethod.CLICK);
  });

  it('X > jami (qarz o`chiq) → 400, hech narsa yozilmaydi', async () => {
    await managerReceives(100_000);
    expect(
      await errorBody(adminTakes(100_001, PaymentMethod.CLICK)),
    ).toMatchObject({
      statusCode: 400,
      message: "Filial kassasida yetarli mablag' yo'q",
    });
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 100_000,
      cash: 100_000,
      card: 0,
    });
    expect((await box('0', Cashbox_type.MAIN)).balance).toBe(1_000_000);
  });

  it('«Kassa qarzga ishlaydi» yoqilgan — jamidan ortiq ruxsat (filial manfiy)', async () => {
    branchDebt = true;
    await managerReceives(100_000);
    const res = await adminTakes(250_000, PaymentMethod.CLICK);
    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: -150_000,
      cash: -150_000,
      card: 0,
    });
    expect((await box('0', Cashbox_type.MAIN)).card).toBe(250_000);
    await assertInvariant();
  });

  it('«Naqd» yo`li: MAIN naqd +X, filial jami −X', async () => {
    await managerReceives(400_000);
    await adminTakes(150_000, PaymentMethod.CASH);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 250_000,
      cash: 250_000,
      card: 0,
    });
    expect(await box('0', Cashbox_type.MAIN)).toEqual({
      balance: 1_150_000,
      cash: 1_150_000,
      card: 0,
    });
  });

  it('«Marketga o`tkazma»: filial jami −X (karta bo`lagi bo`sh bo`lsa ham), MAIN sof 0, market −X; `branch_card_id` e`tiborsiz', async () => {
    await managerReceives(400_000);
    const res = await adminTakes(250_000, PaymentMethod.CLICK_TO_MARKET, {
      market_id: MARKET,
      branch_card_id: '77',
    });
    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 150_000,
      cash: 150_000,
      card: 0,
    });
    expect(await box('0', Cashbox_type.MAIN)).toEqual({
      balance: 1_000_000,
      cash: 1_000_000,
      card: 0,
    });
    expect((await box(MARKET, Cashbox_type.FOR_MARKET)).balance).toBe(750_000);
    // HQ kartasi bu yo'lda — avvalgidek 400.
    expect(
      await errorBody(
        adminTakes(10_000, PaymentMethod.CLICK_TO_MARKET, {
          market_id: MARKET,
          card_id: '5',
        }),
      ),
    ).toMatchObject({ statusCode: 400 });
    await assertInvariant();
  });

  it('eski bo`lingan filial qoldig`i (naqd 0, karta 500 000) — «O`tkazma» 500 000 o`tadi, jami saqlanadi', async () => {
    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 0, balance_card = 500000, balance = 500000
        WHERE cashbox_type = 'branch'`,
    );
    const res = await adminTakes(500_000, PaymentMethod.CLICK);
    expect(res?.statusCode).toBe(200);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 0,
      cash: 0,
      card: 0,
    });
  });

  it('T6: BRANCH qabulini qaytarish va summani tuzatish — jami bo`yicha', async () => {
    const res = await managerReceives(600_000);
    const transferId = res?.data?.transfer_id as string;
    const courierLeg = await db.getRepository(CashboxHistory).findOneOrFail({
      where: {
        transfer_id: transferId,
        operation_type: Operation_type.EXPENSE,
      },
      relations: ['cashbox'],
    });
    expect(courierLeg.cashbox.cashbox_type).toBe(Cashbox_type.FOR_COURIER);

    const corrected: any = await corrections.correctAmount({
      history_id: String(courierLeg.id),
      new_amount: 450_000,
      reason: 'Summa noto`g`ri yozilgan',
      idempotency_key: randomUUID(),
      ...SA,
    });
    expect(corrected?.statusCode).toBe(201);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 450_000,
      cash: 450_000,
      card: 0,
    });
    expect((await box(COURIER, Cashbox_type.FOR_COURIER)).balance).toBe(
      1_550_000,
    );

    // Alohida to'lov — qaytarish.
    const second = await managerReceives(250_000);
    const secondLeg = await db.getRepository(CashboxHistory).findOneOrFail({
      where: {
        transfer_id: second?.data?.transfer_id as string,
        operation_type: Operation_type.EXPENSE,
      },
    });
    const reversed: any = await corrections.reverse({
      history_id: String(secondLeg.id),
      reason: "Xato kiritilgan to'lov",
      idempotency_key: randomUUID(),
      ...SA,
    });
    expect(reversed?.statusCode).toBe(201);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 450_000,
      cash: 450_000,
      card: 0,
    });
    expect((await box(COURIER, Cashbox_type.FOR_COURIER)).balance).toBe(
      1_550_000,
    );
    await assertInvariant();
  });

  it('T6: eski CLICK qabul (karta bo`lagida) — qaytarish jami bo`yicha, karta tekshirilmaydi', async () => {
    // Eski davr: filial karta bo'lagida 200 000 (eski CLICK qabul qatori).
    const res = await managerReceives(200_000);
    const transferId = res?.data?.transfer_id as string;
    await db.query(
      `UPDATE "${schema}".cashbox_history SET payment_method = 'click' WHERE transfer_id = $1`,
      [transferId],
    );
    const courierLeg = await db.getRepository(CashboxHistory).findOneOrFail({
      where: {
        transfer_id: transferId,
        operation_type: Operation_type.EXPENSE,
      },
    });
    const reversed: any = await corrections.reverse({
      history_id: String(courierLeg.id),
      reason: "Xato kiritilgan to'lov",
      idempotency_key: randomUUID(),
      ...SA,
    });
    expect(reversed?.statusCode).toBe(201);
    expect(await box(BRANCH, Cashbox_type.BRANCH)).toEqual({
      balance: 0,
      cash: 0,
      card: 0,
    });
  });

  it('filial smenasi: ochilishda jami, yopishda bitta «Sanalgan summa» (karta 0, tafovut — jami bo`yicha)', async () => {
    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 100000, balance_card = 50000, balance = 150000
        WHERE cashbox_type = 'branch'`,
    );
    const opened: any = await service.openShift({
      opened_by: '8',
      cashbox_user_id: BRANCH,
    });
    expect(Number(opened.data.opening_balance_cash)).toBe(150_000);
    expect(Number(opened.data.opening_balance_card)).toBe(0);

    await managerReceives(300_000);
    await adminTakes(100_000, PaymentMethod.CLICK);

    const closed: any = await service.closeShift({
      closed_by: '8',
      shift_id: String(opened.data.id),
      closing_balance_cash: 340_000,
      cashbox_user_id: BRANCH,
    });
    expect(closed?.statusCode).toBe(200);
    const shift = closed.data;
    expect(Number(shift.expected_balance_cash)).toBe(350_000);
    expect(Number(shift.expected_balance_card)).toBe(0);
    expect(Number(shift.total_income_cash)).toBe(300_000);
    expect(Number(shift.total_expense_cash)).toBe(100_000);
    expect(Number(shift.total_income_card)).toBe(0);
    expect(Number(shift.total_expense_card)).toBe(0);
    expect(Number(shift.closing_balance_cash)).toBe(340_000);
    expect(Number(shift.discrepancy_cash)).toBe(-10_000);
    expect(shift.discrepancy_card).toBeNull();
  });

  it('filial smenasi: eski FE naqd + karta yuborsa — jami sifatida qo`shiladi; ochilishdagi eski karta surati ham jamiga', async () => {
    // Migratsiyadan oldin ochilgan smena (karta surati 50 000) — yopishda
    // soxta tafovut chiqmasin.
    await db.query(
      `INSERT INTO "${schema}".shifts (opened_by, opened_at, status, opening_balance_cash, opening_balance_card, cashbox_user_id)
       VALUES (8, now() - interval '1 hour', 'open', 100000, 50000, ${BRANCH})`,
    );
    const closed: any = await service.closeShift({
      closed_by: '8',
      closing_balance_cash: 120_000,
      closing_balance_card: 30_000,
      cashbox_user_id: BRANCH,
    });
    expect(Number(closed.data.expected_balance_cash)).toBe(150_000);
    expect(Number(closed.data.closing_balance_cash)).toBe(150_000);
    expect(Number(closed.data.discrepancy_cash)).toBe(0);
    expect(closed.data.discrepancy_card).toBeNull();
  });

  it('filial kartalari: ro`yxat bo`sh (kartasiz), yaratish / konvertatsiya → 400; MAIN — avvalgidek', async () => {
    const list: any = await cards.listCards({ branch_id: BRANCH });
    expect(list.data).toMatchObject({
      cashbox_type: 'branch',
      cards: [],
      balance_card: 0,
      cards_disabled: true,
    });
    expect(
      await errorBody(
        cards.createCard({ name: 'Filial Humo', branch_id: BRANCH }),
      ),
    ).toMatchObject({ statusCode: 400 });
    const created: any = await cards.createCard({ name: 'HQ Humo' });
    expect(created?.statusCode).toBe(201);
  });
});
