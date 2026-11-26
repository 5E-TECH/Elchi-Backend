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
import { PaymentCorrectionService } from './payment-correction.service';

/**
 * (2026-11-26, ega) T6 — filial ishtirokidagi to'lovlarni QAYTARISH, haqiqiy
 * Postgres (`FINANCE_OPERATOR_PG_TEST_URI`):
 *  • A — «Marketga o'tkazma» menejer yozgan (kuryer → filial → market, filial
 *    kassasi sof 0): kuryer +X, market +X; daftar `hq_to_market` →
 *    `branch_to_hq` → `courier_to_branch`;
 *  • B — filial kassasidan marketga to'lov (PR-C): filial +X, market +X;
 *    daftar `branch_to_market` ("X:M").
 * Ikkalasida summa tahriri — 409 `reverse_only`. C («Filialdan marketga
 * o'tkazma») — `finance-branch-to-market.pg.spec.ts`.
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
  'T6 — filial to`lovlarini qaytarish (A, B) — haqiqiy Postgres',
  () => {
    const schema = `spec_t6br_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

    describe('A — «Marketga o`tkazma», menejer yozgan (kuryer → filial → market)', () => {
      const pay = () =>
        finance.paymentsFromCourier({
          courier_id: COURIER,
          amount: 300_000,
          payment_method: PaymentMethod.CLICK_TO_MARKET,
          market_id: MARKET,
          receiver_user_id: BRANCH,
          receiver_cashbox_type: Cashbox_type.BRANCH,
          created_by: MANAGER,
          dedup_epoch: 'gw:a-1',
        });

      beforeEach(async () => {
        await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
        await seed(BRANCH, Cashbox_type.BRANCH, 100_000, 0);
        await seed(COURIER, Cashbox_type.FOR_COURIER, 450_000);
        await seed(MARKET, Cashbox_type.FOR_MARKET, 450_000);
      });

      it('⭐ kuryer oyog`idan qaytariladi: hamma kassa to`lovdan oldingi holatda, 4 teskari qator, daftar market → filial → kuryer', async () => {
        const before = await snapshot();
        await pay();
        const original = await originalLegs();
        expect(original).toHaveLength(4);
        const courierLeg = original.find(
          (leg) => leg.cashbox.cashbox_type === Cashbox_type.FOR_COURIER,
        )!;

        const detail: any = await finance.findHistoryById(
          String(courierLeg.id),
          {
            include_correctable: true,
          },
        );
        expect(detail.data.correctable).toMatchObject({
          allowed: true,
          edit_allowed: false,
          transfer: {
            kind: 'courier_payment',
            variant: 'courier_click_branch',
            receiver: { cashbox_type: 'branch', branch_id: BRANCH },
            courier: { id: COURIER },
            market: { id: MARKET },
          },
        });

        outbox.enqueue.mockClear();
        const res = await reverse(String(courierLeg.id), {
          notify_user_ids: [MANAGER],
        });

        expect(res.statusCode).toBe(201);
        expect(res.data.correction).toMatchObject({
          action: 'reverse',
          payment_kind: 'courier_payment',
          original_amount: 300_000,
        });
        expect(await snapshot()).toEqual(before);
        await expectMirrored(original);
        expect(retreats()).toEqual([
          ['hq_to_market', MARKET, 300_000],
          ['branch_to_hq', BRANCH, 300_000],
          ['courier_to_branch', COURIER, 300_000],
        ]);
        // Kuryer, market va filial menejeri — xabar.
        const recipients = corrected.mock.calls.map(
          (call) => (call[0] as { recipient_id: string }).recipient_id,
        );
        expect(recipients.sort()).toEqual([COURIER, MARKET, MANAGER].sort());
        // Market buyurtmalari sinxroni (to'lov orqaga).
        expect(sync).toHaveBeenCalledWith(
          expect.objectContaining({ market_id: MARKET, reverted: 300_000 }),
        );
      });

      it('summa tahriri — 409 reverse_only (har oyoqdan), hech narsa o`zgarmaydi', async () => {
        await pay();
        const after = await snapshot();
        for (const leg of await originalLegs()) {
          expect(await errorBody(correct(String(leg.id)))).toMatchObject({
            statusCode: 409,
            code: 'NOT_CORRECTABLE',
            reason: 'reverse_only',
          });
        }
        expect(await snapshot()).toEqual(after);
        expect(await db.getRepository(PaymentCorrection).count()).toBe(0);
      });

      it('ikkinchi marta (boshqa oyoqdan) — 409 ALREADY_CORRECTED', async () => {
        await pay();
        const original = await originalLegs();
        await reverse(String(original[0].id));
        const after = await snapshot();
        expect(await errorBody(reverse(String(original[3].id)))).toMatchObject({
          statusCode: 409,
          code: 'ALREADY_CORRECTED',
        });
        expect(await snapshot()).toEqual(after);
      });
    });

    describe('B — filial kassasidan marketga to`lov (menejer, PR-C)', () => {
      const pay = (method: PaymentMethod = PaymentMethod.CASH) =>
        finance.paymentsToMarket({
          market_id: MARKET,
          amount: 200_000,
          payment_method: method,
          payer_cashbox_type: Cashbox_type.BRANCH,
          payer_user_id: BRANCH,
          created_by: MANAGER,
          dedup_epoch: `gw:b-${randomUUID()}`,
          branch_share: 1_000_000,
        });

      beforeEach(async () => {
        await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
        await seed(BRANCH, Cashbox_type.BRANCH, 500_000, 0);
        await seed(MARKET, Cashbox_type.FOR_MARKET, 400_000);
      });

      it.each([PaymentMethod.CASH, PaymentMethod.CLICK])(
        '⭐ %s: market oyog`idan qaytariladi — filial +X, market +X, HQ tegilmaydi; daftar branch_to_market',
        async (method) => {
          const before = await snapshot();
          await pay(method);
          expect(await box(BRANCH, Cashbox_type.BRANCH)).toMatchObject({
            balance: 300_000,
          });
          const original = await originalLegs();
          expect(original).toHaveLength(2);
          const marketLeg = original.find(
            (leg) => leg.cashbox.cashbox_type === Cashbox_type.FOR_MARKET,
          )!;

          const detail: any = await finance.findHistoryById(
            String(marketLeg.id),
            { include_correctable: true },
          );
          expect(detail.data.correctable).toMatchObject({
            allowed: true,
            edit_allowed: false,
            transfer: {
              kind: 'market_payment',
              variant: 'market_branch',
              receiver: { cashbox_type: 'branch', branch_id: BRANCH },
              courier: null,
              market: { id: MARKET },
            },
          });

          outbox.enqueue.mockClear();
          const res = await reverse(String(marketLeg.id), {
            notify_user_ids: [MANAGER],
          });
          expect(res.statusCode).toBe(201);
          expect(res.data.correction).toMatchObject({
            action: 'reverse',
            payment_kind: 'market_payment',
            original_amount: 200_000,
          });
          expect(await snapshot()).toEqual(before);
          await expectMirrored(original);
          expect(retreats()).toEqual([
            ['branch_to_market', `${BRANCH}:${MARKET}`, 200_000],
          ]);
          const recipients = corrected.mock.calls.map(
            (call) => (call[0] as { recipient_id: string }).recipient_id,
          );
          expect(recipients.sort()).toEqual([MARKET, MANAGER].sort());
          expect(sync).toHaveBeenCalledWith(
            expect.objectContaining({ market_id: MARKET, reverted: 200_000 }),
          );
        },
      );

      it('summa tahriri — 409 reverse_only; HQ marketga to`lovi esa avvalgidek tahrirlanadi', async () => {
        await pay();
        for (const leg of await originalLegs()) {
          expect(await errorBody(correct(String(leg.id)))).toMatchObject({
            statusCode: 409,
            code: 'NOT_CORRECTABLE',
            reason: 'reverse_only',
          });
        }
        expect(await db.getRepository(PaymentCorrection).count()).toBe(0);

        // HQ (MAIN) dan to'lov — `edit_allowed: true`, tahrir o'tadi.
        await finance.paymentsToMarket({
          market_id: MARKET,
          amount: 150_000,
          payment_method: PaymentMethod.CASH,
          created_by: '1',
          dedup_epoch: 'gw:hq-1',
        });
        const hqLeg = (await originalLegs()).find(
          (leg) =>
            leg.cashbox.cashbox_type === Cashbox_type.MAIN &&
            leg.operation_type === Operation_type.EXPENSE,
        )!;
        const detail: any = await finance.findHistoryById(String(hqLeg.id), {
          include_correctable: true,
        });
        expect(detail.data.correctable).toMatchObject({
          allowed: true,
          edit_allowed: true,
          transfer: { variant: 'market' },
        });
        const edited: any = await correct(String(hqLeg.id));
        expect(edited.statusCode).toBe(201);
        expect(edited.data.correction).toMatchObject({
          action: 'edit',
          new_amount: 100_000,
        });
      });
    });

    describe('(2026-11-26) Excel «Yo`nalish» — `include_route`', () => {
      beforeEach(async () => {
        await seed('0', Cashbox_type.MAIN, 1_000_000, 0);
        await seed(BRANCH, Cashbox_type.BRANCH, 500_000, 0);
        await seed(COURIER, Cashbox_type.FOR_COURIER, 900_000);
        await seed(MARKET, Cashbox_type.FOR_MARKET, 900_000);
      });

      const routeOf = async (
        cashbox_type: Cashbox_type,
        source_type: Source_type,
      ) => {
        const res: any = await finance.findAllHistory({
          cashbox_type,
          source_type,
          page: 0,
          limit: 0,
          include_route: true,
        });
        return (res.data.items as Array<Record<string, any>>).map(
          (row) => row.route,
        );
      };

      it('⭐ A, B, HQ to`lovi — har kassada butun to`lov yo`nalishi (kuryer, filial, market, nomlar); teskari qator — asl yo`nalish', async () => {
        await finance.paymentsFromCourier({
          courier_id: COURIER,
          amount: 300_000,
          payment_method: PaymentMethod.CLICK_TO_MARKET,
          market_id: MARKET,
          receiver_user_id: BRANCH,
          receiver_cashbox_type: Cashbox_type.BRANCH,
          created_by: MANAGER,
          dedup_epoch: 'gw:r-a',
        });
        await finance.paymentsToMarket({
          market_id: MARKET,
          amount: 200_000,
          payment_method: PaymentMethod.CASH,
          payer_cashbox_type: Cashbox_type.BRANCH,
          payer_user_id: BRANCH,
          created_by: MANAGER,
          dedup_epoch: 'gw:r-b',
          branch_share: 1_000_000,
        });
        await finance.paymentsToMarket({
          market_id: MARKET,
          amount: 100_000,
          payment_method: PaymentMethod.CASH,
          created_by: '1',
          dedup_epoch: 'gw:r-hq',
        });

        const market = await routeOf(
          Cashbox_type.FOR_MARKET,
          Source_type.MARKET_PAYMENT,
        );
        expect(market.map((route) => route?.variant).sort()).toEqual(
          ['courier_click_branch', 'market', 'market_branch'].sort(),
        );
        const viaBranch = market.find(
          (route) => route?.variant === 'courier_click_branch',
        );
        expect(viaBranch).toEqual({
          variant: 'courier_click_branch',
          cashbox_type: 'branch',
          branch_id: BRANCH,
          courier: { id: COURIER, name: `Foydalanuvchi ${COURIER}` },
          market: { id: MARKET, name: `Foydalanuvchi ${MARKET}` },
        });
        expect(
          market.find((route) => route?.variant === 'market_branch'),
        ).toMatchObject({
          cashbox_type: 'branch',
          branch_id: BRANCH,
          courier: null,
        });
        expect(
          market.find((route) => route?.variant === 'market'),
        ).toMatchObject({ cashbox_type: 'main', branch_id: null });

        // Kuryer kassasidan ham — o'sha yo'nalish.
        expect(
          await routeOf(Cashbox_type.FOR_COURIER, Source_type.COURIER_PAYMENT),
        ).toEqual([
          expect.objectContaining({ variant: 'courier_click_branch' }),
        ]);

        // B qaytarildi — teskari qatorlar asl yo'nalish bilan.
        const bLeg = (
          await db.getRepository(CashboxHistory).find({
            where: { source_type: Source_type.MARKET_PAYMENT },
            relations: ['cashbox'],
          })
        ).find(
          (leg) =>
            leg.cashbox.cashbox_type === Cashbox_type.BRANCH &&
            leg.payment_method === PaymentMethod.CASH,
        )!;
        await reverse(String(bLeg.id));
        const reversals = await routeOf(
          Cashbox_type.FOR_MARKET,
          Source_type.PAYMENT_REVERSAL,
        );
        expect(reversals).toEqual([
          expect.objectContaining({
            variant: 'market_branch',
            branch_id: BRANCH,
          }),
        ]);
      });

      it('`include_route` siz — `route` kaliti yo`q (oddiy ro`yxat avvalgidek)', async () => {
        await finance.paymentsToMarket({
          market_id: MARKET,
          amount: 100_000,
          payment_method: PaymentMethod.CASH,
          created_by: '1',
          dedup_epoch: 'gw:r-plain',
        });
        const res: any = await finance.findAllHistory({
          cashbox_type: Cashbox_type.FOR_MARKET,
          page: 0,
          limit: 0,
        });
        expect(res.data.items).toHaveLength(1);
        expect(res.data.items[0]).not.toHaveProperty('route');
      });
    });
  },
);
