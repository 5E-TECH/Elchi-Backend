import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource, IsNull } from 'typeorm';
import { RpcException } from '@nestjs/microservices';
import {
  Cashbox_type,
  Operation_type,
  OutboxEvent,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { PaymentCorrection } from '../entities/payment-correction.entity';
import { Shift } from '../entities/shift.entity';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { PaymentCorrectionService } from '../payment-correction/payment-correction.service';
import { FinanceDailyService } from '../aggregates/finance-daily.service';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from '../entities/finance-daily-snapshot.entity';

/**
 * (2026-11-26, ega) O'tkazma izi — «Marketga o'tkazma» (HQ yoki menejer
 * yozgan), «Filialdan marketga o'tkazma»: pul kassaga KIRMAGAN, lekin asosiy /
 * filial kassasida bitta to'lov ichida «Kirim +X» va «Chiqim −X» bor. Haqiqiy
 * Postgres: jamilar (asosiy kassa, kassa sahifasi, kunlik agregat), «Kirim» /
 * «Chiqim» tablari va sonlari, qatorlardagi `pass_through` belgisi va juft;
 * qaytarilgan (T6) juftning teskari yozuvlari ham iz.
 */
// CI: FINANCE_PG_TEST_URI (o`z sxemasi — umumiy bazada xavfsiz).
const pgUri =
  process.env.FINANCE_OPERATOR_PG_TEST_URI ?? process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const BRANCH = '15';
const MARKET = '201';
const COURIER = '209';
const MANAGER = '15001';
const SA = { requester_id: '1', requester_roles: ['superadmin'] };

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

describePg(
  'O`tkazma izi — jamilarga kirmaydi, bitta qator (haqiqiy Postgres)',
  () => {
    const schema = `spec_ptr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let finance: FinanceServiceService;
    let corrections: PaymentCorrectionService;
    let notifications: FinanceNotificationService;
    let corrected: jest.SpyInstance;
    let sync: jest.SpyInstance;
    /** Haqiqiy `outbox_events` qatori: B ulush tekshiruvi shundan o'qiydi. */
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
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const orderClient = {
      send: jest.fn((pattern: { cmd?: string }, payload: any) => {
        if (pattern?.cmd === 'order.settlement.branch_market_share') {
          const pending = Array.isArray(payload?.pending_tokens)
            ? (payload.pending_tokens as string[])
            : [];
          return of({
            statusCode: 200,
            data: {
              in_branch: true,
              share: 1_000_000,
              applied_tokens: pending,
            },
          });
        }
        return of({ statusCode: 200, data: {} });
      }),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
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
        if (pattern.cmd === 'identity.user.find_by_id') {
          return of({
            data: {
              id: payload?.id,
              name: `Foydalanuvchi ${String(payload?.id)}`,
              role: 'market',
              cashbox_debt_enabled: false,
            },
          });
        }
        return of({ data: [] });
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
          FinancialBalanceHistory,
          FinanceSetting,
          PaymentCorrection,
          Shift,
          OutboxEvent,
          FinanceCashboxDaily,
          FinanceDailySnapshot,
        ],
        synchronize: true,
      });
      await db.initialize();
      notifications = new FinanceNotificationService(outbox as never);
      const realtime = new FinanceRealtimeService(outbox as never);
      finance = new FinanceServiceService(
        db.getRepository(Cashbox),
        db.getRepository(CashboxHistory),
        db.getRepository(Shift),
        {} as never,
        {} as never,
        {} as never,
        db.getRepository(FinancialBalanceHistory),
        db,
        activityLog as never,
        orderClient as never,
        { send: jest.fn(() => of({})) } as never,
        identityClient as never,
        outbox as never,
        notifications,
        undefined,
        undefined,
        realtime,
      );
      jest
        .spyOn(finance as never, 'tryPublishAdvanceNow')
        .mockResolvedValue(undefined as never);
      jest
        .spyOn(finance as never, 'scheduleMarketPaymentFollowUp')
        .mockResolvedValue(undefined as never);
      sync = jest
        .spyOn(finance, 'scheduleMarketPaymentCorrectionSync')
        .mockResolvedValue(undefined);
      corrected = jest.spyOn(notifications, 'paymentCorrected');
      corrections = new PaymentCorrectionService(
        db,
        finance,
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
      corrected.mockClear();
      sync.mockClear();
      await db.query(
        `TRUNCATE TABLE "${schema}".cashbox_history, "${schema}".cashboxes,
        "${schema}".financial_balance_history, "${schema}".payment_corrections,
        "${schema}".finance_settings, "${schema}".cashbox_cards,
        "${schema}".shifts, "${schema}".outbox_events
        RESTART IDENTITY CASCADE`,
      );
    });

    const seed = (
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

    const snapshot = async () => {
      const all = await db
        .getRepository(Cashbox)
        .find({ order: { id: 'ASC' } });
      return all.map((row) => ({
        user_id: String(row.user_id),
        type: row.cashbox_type,
        balance: Number(row.balance),
        cash: Number(row.balance_cash),
        card: Number(row.balance_card),
      }));
    };

    const originalLegs = () =>
      db.getRepository(CashboxHistory).find({
        where: { reverses_history_id: IsNull() },
        relations: ['cashbox'],
        order: { id: 'ASC' },
      });

    const retreats = () =>
      outbox.enqueue.mock.calls
        .filter((call) => call[1] === 'order.settlement.retreat')
        .map((call) => {
          const payload = call[2] as Record<string, unknown>;
          return [payload.level, payload.match_value, payload.amount];
        });

    const reverse = (history_id: string, extra: Record<string, unknown> = {}) =>
      corrections.reverse({
        history_id,
        reason: "Xato kiritilgan to'lov",
        idempotency_key: randomUUID(),
        ...SA,
        ...extra,
      }) as Promise<any>;

    const correct = (history_id: string) =>
      corrections.correctAmount({
        history_id,
        new_amount: 100_000,
        reason: "Summa noto'g'ri yozilgan",
        idempotency_key: randomUUID(),
        ...SA,
      });

    /** Teskari qatorlar: har asl oyoqqa bittadan, amali teskari, summa / usul asl. */
    const expectMirrored = async (original: CashboxHistory[]) => {
      const reversals = await db.getRepository(CashboxHistory).find({
        where: { source_type: Source_type.PAYMENT_REVERSAL },
      });
      expect(reversals).toHaveLength(original.length);
      for (const leg of original) {
        const mirror = reversals.find(
          (row) => String(row.reverses_history_id) === String(leg.id),
        );
        expect(mirror).toBeDefined();
        expect(mirror!.operation_type).not.toBe(leg.operation_type);
        expect(Number(mirror!.amount)).toBe(Number(leg.amount));
        expect(mirror!.payment_method).toBe(leg.payment_method);
        expect(String(mirror!.cashbox_id)).toBe(String(leg.cashbox_id));
      }
    };

    const daily = () => new FinanceDailyService(db);

    beforeEach(async () => {
      await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
      await seed(BRANCH, Cashbox_type.BRANCH, 500_000, 0);
      await seed(COURIER, Cashbox_type.FOR_COURIER, 2_000_000);
      await seed(MARKET, Cashbox_type.FOR_MARKET, 2_000_000);
    });

    /** HQ: naqd 400 000 (haqiqiy kirim) + «Marketga o'tkazma» 300 000 (iz). */
    const hqPayments = async () => {
      await finance.paymentsFromCourier({
        courier_id: COURIER,
        amount: 400_000,
        payment_method: PaymentMethod.CASH,
        created_by: '1',
        dedup_epoch: 'gw:pt-cash',
      });
      await finance.paymentsFromCourier({
        courier_id: COURIER,
        amount: 300_000,
        payment_method: PaymentMethod.CLICK_TO_MARKET,
        market_id: MARKET,
        created_by: '1',
        dedup_epoch: 'gw:pt-ctm',
      });
    };

    it('⭐ asosiy kassa: iz jamiga kirmaydi (kirim 400 000, chiqim 0), qatorlarda belgi va juft; qoldiq o`zgarmagan', async () => {
      await hqPayments();
      const res: any = await finance.getMainCashbox({});
      expect(res.data.income).toBe(400_000);
      expect(res.data.outcome).toBe(0);
      expect(Number(res.data.cashbox.balance)).toBe(1_400_000);
      const rows = res.data.cashboxHistory as Array<Record<string, any>>;
      expect(rows).toHaveLength(3);
      const traces = rows.filter((row) => row.pass_through === true);
      expect(traces.map((row) => row.operation_type).sort()).toEqual([
        'expense',
        'income',
      ]);
      expect(traces[0].pass_through_pair_id).toBe(String(traces[1].id));
      expect(traces[1].pass_through_pair_id).toBe(String(traces[0].id));
      const cash = rows.find(
        (row) => row.payment_method === PaymentMethod.CASH,
      )!;
      expect(cash).not.toHaveProperty('pass_through');
    });

    it('⭐ tarix ro`yxati: «Kirim» / «Chiqim» tablarida iz yo`q; sonlar — kirim 1, chiqim 0, barchasi 2 (juft bitta)', async () => {
      await hqPayments();
      const list = async (extra: Record<string, unknown> = {}) =>
        (await finance.findAllHistory({
          cashbox_type: Cashbox_type.MAIN,
          page: 1,
          limit: 20,
          ...extra,
        })) as any;
      const all = await list();
      expect(all.data.items).toHaveLength(3);
      expect(all.data.counts).toEqual({ all: 2, income: 1, expense: 0 });
      const income = await list({ operation_type: Operation_type.INCOME });
      expect(income.data.items).toHaveLength(1);
      expect(income.data.items[0].payment_method).toBe(PaymentMethod.CASH);
      const expense = await list({ operation_type: Operation_type.EXPENSE });
      expect(expense.data.items).toHaveLength(0);
      // Tafsilot — belgi va juft.
      const trace = (all.data.items as Array<Record<string, any>>).find(
        (row) => row.pass_through,
      )!;
      const detail: any = await finance.findHistoryById(String(trace.id));
      expect(detail.data).toMatchObject({
        pass_through: true,
        pass_through_pair_id: trace.pass_through_pair_id,
      });
    });

    it('⭐ kunlik agregat («Balans harakati»): iz kirim / chiqimga kirmaydi', async () => {
      await hqPayments();
      const res: any = await daily().historyDaily({ cashbox_type: 'main' });
      expect(res.data?.totals ?? res.totals).toMatchObject({
        income: 400_000,
        expense: 0,
        income_count: 1,
        expense_count: 0,
      });
    });

    it('⭐ menejer yozgan «Marketga o`tkazma» — filial kassasi sahifasida kirim / chiqim 0, ikkala qator iz', async () => {
      await finance.paymentsFromCourier({
        courier_id: COURIER,
        amount: 300_000,
        payment_method: PaymentMethod.CLICK_TO_MARKET,
        market_id: MARKET,
        receiver_user_id: BRANCH,
        receiver_cashbox_type: Cashbox_type.BRANCH,
        created_by: MANAGER,
        dedup_epoch: 'gw:pt-a',
      });
      const res: any = await finance.getCashboxByUserId({
        id: BRANCH,
        cashbox_type: Cashbox_type.BRANCH,
      });
      expect(res.data.income).toBe(0);
      expect(res.data.outcome).toBe(0);
      expect(
        (res.data.cashboxHistory as Array<Record<string, any>>).every(
          (row) => row.pass_through === true,
        ),
      ).toBe(true);
      // Kuryer kassasida — bitta haqiqiy chiqim (iz emas).
      const courier: any = await finance.getCashboxByUserId({
        id: COURIER,
        cashbox_type: Cashbox_type.FOR_COURIER,
      });
      expect(courier.data.outcome).toBe(300_000);
      expect(courier.data.cashboxHistory[0]).not.toHaveProperty('pass_through');
    });

    it('qaytarilgan o`tkazma: teskari yozuvlar ham iz — asosiy kassa jamilari o`zgarmaydi', async () => {
      await hqPayments();
      const legs = await db.getRepository(CashboxHistory).find({
        relations: ['cashbox'],
      });
      const courierLeg = legs.find(
        (leg) =>
          leg.cashbox.cashbox_type === Cashbox_type.FOR_COURIER &&
          leg.payment_method === PaymentMethod.CLICK_TO_MARKET,
      )!;
      await reverse(String(courierLeg.id));
      const res: any = await finance.getMainCashbox({});
      expect(res.data.income).toBe(400_000);
      expect(res.data.outcome).toBe(0);
      expect(
        (res.data.cashboxHistory as Array<Record<string, any>>).filter(
          (row) => row.pass_through,
        ),
      ).toHaveLength(4);
    });
  },
);
