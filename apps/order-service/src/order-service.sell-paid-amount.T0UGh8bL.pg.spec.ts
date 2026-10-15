/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  IdempotencyKey,
  Order_status,
  OutboxEvent,
  OutboxService,
  PaymentMethod,
  SettlementStatus,
} from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { FinanceServiceService } from '../../finance-service/src/finance-service.service';
import { Cashbox } from '../../finance-service/src/entities/cashbox.entity';
import { CashboxHistory } from '../../finance-service/src/entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../../finance-service/src/entities/financial-balance-history.entity';

/**
 * T0UGh8bL — HAQIQIY Postgres: `sell {paidAmount}` (ZsPLevZZ (a) yo'li) pul
 * oqimi to'liq zanjirda — order-service sotuvi (haqiqiy tranzaksiya, haqiqiy
 * outbox), finance-service `updateBalance` / `paymentsFromCourier` /
 * `paymentsToMarket` (haqiqiy kassa + tarix) va settlement FIFO
 * (`advanceSettlement`). Relay — outbox qatorlarini tartib bilan finance'ga
 * uzatadigan kichik sikl (prod'dagi OutboxPublisher o'rnida).
 *
 * Har qadamdan keyin `scripts/check-cashbox-invariant.ts --reconcile-strict`
 * ning settlement↔cashbox so'rovi AYNAN shu bazada bajariladi:
 *   FOR_MARKET balance == Σ market_amount (status <> market_settled)
 * va kuryer bo'g'ini: FOR_COURIER balance == Σ PENDING courier_amount.
 *
 * Faqat lokal test bazasi (SELL_PAID_AMOUNT_PG_TEST_URI,
 * .../elchi_oct6_sell_paid_test) berilsa ishlaydi.
 */
const uri = process.env.SELL_PAID_AMOUNT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_oct6_sell_paid_test'
  );
})();

type Row = Record<string, any>;

const MARKET_ID = '501';
const COURIER_ID = '301';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: null };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
// Market markaz tarifi 45 000, kuryer markaz tarifi 30 000 (HQ kuryeri).
const MARKET_TARIFF = 45000;
const COURIER_TARIFF = 30000;

(localTestDatabase ? describe : describe.skip)(
  'T0UGh8bL — sell {paidAmount}: kassa ↔ settlement haqiqiy Postgres zanjirida (pg)',
  () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
    const orderSchema = `spec_t0u_order_${suffix}`;
    const financeSchema = `spec_t0u_fin_${suffix}`;
    let admin: DataSource;
    let orderDb: DataSource;
    let financeDb: DataSource;
    let lifecycle: OrderLifecycleService;
    let settlement: OrderSettlementService;
    let finance: FinanceServiceService;
    /** finance outbox'i (settlement advance) — relay'da order-service'ga. */
    const financeAdvances: Row[] = [];

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${orderSchema}"`);
      await admin.query(`CREATE SCHEMA "${financeSchema}"`);
      await admin.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');

      orderDb = new DataSource({
        type: 'postgres',
        url: uri,
        schema: orderSchema,
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          OrderSettlement,
          OrderSettlementCarry,
          OutboxEvent,
          IdempotencyKey,
        ],
        synchronize: true,
      });
      await orderDb.initialize();

      financeDb = new DataSource({
        type: 'postgres',
        url: uri,
        schema: financeSchema,
        entities: [Cashbox, CashboxHistory, FinancialBalanceHistory],
        synchronize: true,
      });
      await financeDb.initialize();

      finance = new FinanceServiceService(
        financeDb.getRepository(Cashbox),
        financeDb.getRepository(CashboxHistory),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        financeDb.getRepository(FinancialBalanceHistory),
        financeDb,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { send: jest.fn(() => of({ statusCode: 200, data: {} })) } as never,
        { send: jest.fn(() => of({})) } as never,
        { send: jest.fn(() => of({})) } as never,
        {
          enqueue: jest.fn((_target: string, pattern: string, payload: Row) => {
            if (pattern === 'order.settlement.advance') {
              financeAdvances.push(payload);
            }
            return Promise.resolve(undefined);
          }),
        } as never,
      );
      // Fon follow-up (buyurtma holati sinxroni, hamkor xabari) — bu yerda emas.
      jest
        .spyOn(finance as never, 'scheduleMarketPaymentFollowUp')
        .mockResolvedValue(undefined as never);
      jest
        .spyOn(finance as never, 'tryPublishAdvanceNow')
        .mockResolvedValue(undefined as never);

      const lookup = {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn().mockResolvedValue([
          {
            id: MARKET_ID,
            tariff_center: MARKET_TARIFF,
            tariff_home: 70000,
            expense_proof_conditions: [],
          },
        ]),
        getCouriersByIds: jest.fn((ids: string[]) =>
          Promise.resolve(
            ids.map((id) => ({
              id,
              tariff_center: COURIER_TARIFF,
              tariff_home: 50000,
              can_add_extra_cost: true,
              can_sell_cancel: true,
            })),
          ),
        ),
        getUserById: jest.fn().mockResolvedValue(null),
        // Qoldiq HAQIQIY finance kassasidan (autoPay va X chegarasi uchun).
        getCashboxByUser: jest.fn(async (userId: string, type: Cashbox_type) =>
          financeDb.getRepository(Cashbox).findOne({
            where: { user_id: String(userId), cashbox_type: type },
          }),
        ),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        // HQ kuryeri: settlement filiali yo'q (kuryer → HQ to'g'ridan-to'g'ri).
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
      };

      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Row;
      Object.assign(instance, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        dataSource: orderDb,
        orderRepo: orderDb.getRepository(Order),
        orderSettlementRepo: orderDb.getRepository(OrderSettlement),
        outbox: new OutboxService(orderDb.getRepository(OutboxEvent)),
        lookup,
        logisticsClient: {
          send: jest.fn(() =>
            of({ data: { id: '9001', courier_id: COURIER_ID } }),
          ),
        },
        custody: {
          createTrackingEvent: jest.fn(),
          createCustodyEvent: jest.fn(),
          toTrackingRole: jest.fn(() => 'courier'),
          auditActor: jest.fn(() => ({})),
        },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
        enqueueFinanceOnStatusChange: jest.fn().mockResolvedValue(undefined),
        queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
        enforceOperationProof: jest.fn().mockResolvedValue([]),
        requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
      });
      lifecycle = instance;

      settlement = new OrderSettlementService(
        orderDb,
        orderDb.getRepository(OrderSettlement),
        {} as never,
        lookup as never,
      );
    }, 60_000);

    afterAll(async () => {
      if (orderDb?.isInitialized) await orderDb.destroy();
      if (financeDb?.isInitialized) await financeDb.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${orderSchema}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${financeSchema}" CASCADE`);
        await admin.query('DROP SCHEMA IF EXISTS "branch_schema" CASCADE');
        await admin.destroy();
      }
    });

    const seedCashbox = (user_id: string, cashbox_type: Cashbox_type) =>
      financeDb.getRepository(Cashbox).save(
        financeDb.getRepository(Cashbox).create({
          user_id,
          cashbox_type,
          balance: 0,
          balance_cash: 0,
          balance_card: 0,
        }),
      );

    const addOrder = (id: string, total: number) =>
      orderDb.query(
        `INSERT INTO "${orderSchema}".orders
          (id, market_id, customer_id, status, source, total_price,
           where_deliver, holder_type, holder_courier_id, courier_id, post_id)
         VALUES ($1, $2, 801, 'waiting', 'internal', $3, 'center', 'COURIER',
                 $4, $4, 9001)`,
        [id, MARKET_ID, total, COURIER_ID],
      );

    beforeEach(async () => {
      financeAdvances.length = 0;
      await orderDb.query(
        `TRUNCATE "${orderSchema}".orders, "${orderSchema}".order_settlement,
          "${orderSchema}".order_settlement_carry, "${orderSchema}".outbox_events,
          "${orderSchema}".idempotency_keys RESTART IDENTITY CASCADE`,
      );
      await financeDb.query(
        `TRUNCATE "${financeSchema}".cashbox_history,
          "${financeSchema}".financial_balance_history,
          "${financeSchema}".cashboxes RESTART IDENTITY CASCADE`,
      );
      await seedCashbox('0', Cashbox_type.MAIN);
      await seedCashbox(MARKET_ID, Cashbox_type.FOR_MARKET);
      await seedCashbox(COURIER_ID, Cashbox_type.FOR_COURIER);
    });

    /** Outbox relay: kutilayotgan kassa hodisalari TARTIB bilan finance'ga. */
    const relay = async () => {
      const rows: Array<{ id: string; pattern: string; payload: Row }> =
        await orderDb.query(
          `SELECT id, pattern, payload FROM "${orderSchema}".outbox_events
           WHERE status = 'pending' ORDER BY id`,
        );
      for (const row of rows) {
        if (row.pattern === 'finance.cashbox.update_balance') {
          await finance.updateBalance(row.payload as never);
        }
        await orderDb.query(
          `UPDATE "${orderSchema}".outbox_events SET status = 'sent' WHERE id = $1`,
          [row.id],
        );
      }
      return rows.length;
    };

    /** finance outbox'idagi settlement siljishlari → order-service FIFO. */
    const relayAdvances = async () => {
      for (const payload of financeAdvances.splice(0)) {
        await settlement.advanceSettlement(payload as never);
      }
    };

    const balance = async (user_id: string, cashbox_type: Cashbox_type) =>
      Number(
        (
          await financeDb
            .getRepository(Cashbox)
            .findOneByOrFail({ user_id, cashbox_type })
        ).balance,
      );

    const order = async (id: string) =>
      (
        await orderDb.query(
          `SELECT status, paid_amount, to_be_paid,
                  sale_market_paid_amount::float8 AS sale_market_paid_amount
           FROM "${orderSchema}".orders WHERE id = $1`,
          [id],
        )
      )[0] as Row;

    const settlementRow = async (id: string) =>
      (
        await orderDb.query(
          `SELECT status::text AS status, courier_amount::float8 AS courier,
                  branch_amount::float8 AS branch,
                  market_amount::float8 AS market
           FROM "${orderSchema}".order_settlement
           WHERE order_id = $1 AND is_deleted = false`,
          [id],
        )
      )[0] as Row;

    /**
     * `check-cashbox-invariant.ts --reconcile-strict` (settlement↔cashbox)
     * so'rovi AYNAN, + kassa balansi == o'z tarixi yig'indisi (I1) va kuryer
     * bo'g'ini.
     */
    const assertInvariants = async () => {
      const marketRecon: Row[] = await admin.query(
        `SELECT cb.user_id AS market_id,
                cb.balance::float8 AS cashbox_balance,
                COALESCE((
                  SELECT SUM(os.market_amount) FROM "${orderSchema}".order_settlement os
                  WHERE os.is_deleted = false AND os.status <> 'market_settled'
                    AND os.market_id = cb.user_id
                ), 0)::float8 AS unsettled_owed
         FROM "${financeSchema}".cashboxes cb
         WHERE cb.cashbox_type = 'markets' AND cb.is_deleted = false`,
      );
      for (const m of marketRecon) {
        expect({
          market: m.market_id,
          diff: m.cashbox_balance - m.unsettled_owed,
        }).toEqual({ market: m.market_id, diff: 0 });
      }
      const historyDrift: Row[] = await admin.query(
        `SELECT cb.id, cb.balance::float8 AS balance,
                COALESCE(SUM(CASE WHEN h.operation_type = 'income' THEN h.amount
                                  ELSE -h.amount END), 0)::float8 AS history
         FROM "${financeSchema}".cashboxes cb
         LEFT JOIN "${financeSchema}".cashbox_history h ON h.cashbox_id = cb.id
         GROUP BY cb.id, cb.balance`,
      );
      for (const c of historyDrift) {
        expect(c.balance).toBe(c.history);
      }
      const courierOwed = Number(
        (
          await orderDb.query(
            `SELECT COALESCE(SUM(courier_amount), 0)::float8 AS s
             FROM "${orderSchema}".order_settlement
             WHERE is_deleted = false AND status = 'pending' AND courier_id = $1`,
            [COURIER_ID],
          )
        )[0].s,
      );
      const carry = Number(
        (
          await orderDb.query(
            `SELECT COALESCE(SUM(amount), 0)::float8 AS s
             FROM "${orderSchema}".order_settlement_carry
             WHERE level = 'courier_to_branch' AND party_id = $1`,
            [COURIER_ID],
          )
        )[0].s,
      );
      expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(
        courierOwed - carry,
      );
    };

    const sell = async (id: string, dto: Row, requestId: string) => {
      const res = await lifecycle.sellOrder(COURIER, id, dto, requestId);
      await relay();
      await assertInvariants();
      return res as { data: Row };
    };

    it('⭐ X bilan (to`liq / qisman) va X siz sotuv → kuryer → HQ → market: identiklik har qadamda, dublikat to`lov yo`q', async () => {
      await addOrder('7001', 250000); // marketga 205 000
      await addOrder('7002', 150000); // marketga 105 000
      await addOrder('7003', 100000); // marketga  55 000

      // ZsPLevZZ TC1: to'liq X — market kassasi O'ZGARMAYDI (income + teng expense).
      const full = await sell('7001', { paidAmount: 205000 }, 'sell-7001');
      expect(full.data).toMatchObject({ status: Order_status.PAID });
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(0);
      expect(await order('7001')).toMatchObject({
        status: Order_status.PAID,
        paid_amount: 205000,
        sale_market_paid_amount: 205000,
      });
      expect(await settlementRow('7001')).toEqual({
        status: SettlementStatus.PENDING,
        courier: 15000,
        branch: 15000,
        market: 0,
      });

      // Qisman X — PARTLY_PAID.
      await sell('7002', { paidAmount: 50000 }, 'sell-7002');
      expect(await order('7002')).toMatchObject({
        status: Order_status.PARTLY_PAID,
        paid_amount: 50000,
      });
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(55000);

      // ZsPLevZZ TC2 regressiya: paidAmount 0 — SOLD, snapshot yo'q.
      await sell('7003', { paidAmount: 0 }, 'sell-7003');
      expect(await order('7003')).toMatchObject({
        status: Order_status.SOLD,
        paid_amount: 0,
        sale_market_paid_amount: null,
      });

      // Kuryer kassasi: (220 000 − 205 000) + (120 000 − 50 000) + 70 000.
      const courierDue = await balance(COURIER_ID, Cashbox_type.FOR_COURIER);
      expect(courierDue).toBe(15000 + 70000 + 70000);

      // Kuryer qolgan naqdni HQ'ga topshiradi (finance + FIFO).
      await finance.paymentsFromCourier({
        courier_id: COURIER_ID,
        amount: courierDue,
        payment_method: PaymentMethod.CASH,
        created_by: '1',
        dedup_epoch: 'pay-courier-1',
      });
      await relayAdvances();
      await assertInvariants();
      for (const id of ['7001', '7002', '7003']) {
        expect((await settlementRow(id)).status).toBe(
          SettlementStatus.BRANCH_SETTLED,
        );
      }

      // ZsPLevZZ TC4: HQ marketga kassadagi qarzni to'laydi — X qaytadan
      // to'lanmaydi: 205 000 + 105 000 + 55 000 − (205 000 + 50 000).
      const marketDue = await balance(MARKET_ID, Cashbox_type.FOR_MARKET);
      expect(marketDue).toBe(110000);
      await finance.paymentsToMarket({
        market_id: MARKET_ID,
        amount: marketDue,
        payment_method: PaymentMethod.CASH,
        created_by: '1',
        dedup_epoch: 'pay-market-1',
      });
      await relayAdvances();
      await assertInvariants();
      for (const id of ['7001', '7002', '7003']) {
        expect((await settlementRow(id)).status).toBe(
          SettlementStatus.MARKET_SETTLED,
        );
      }
      const marketCarry = await orderDb.query(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS s
         FROM "${orderSchema}".order_settlement_carry WHERE level = 'hq_to_market'`,
      );
      expect(Number(marketCarry[0].s)).toBe(0);

      // Ikkinchi marta to'lash urinishi — finance qo'riqchisi (qarz 0) rad etadi.
      await expect(
        finance.paymentsToMarket({
          market_id: MARKET_ID,
          amount: 50000,
          payment_method: PaymentMethod.CASH,
          created_by: '1',
          dedup_epoch: 'pay-market-2',
        }),
      ).rejects.toBeDefined();
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(0);

      // Pul saqlanishi (kompaniya darajasida): market jami
      // 205 000 + 50 000 (sotuvda) + 110 000 (HQ) = Σ(narx − tarif);
      // HQ'da 3 × (45 000 − 30 000) foyda; oraliq kassalar 0.
      expect(205000 + 50000 + marketDue).toBe(205000 + 105000 + 55000);
      expect(await balance('0', Cashbox_type.MAIN)).toBe(
        3 * (MARKET_TARIFF - COURIER_TARIFF),
      );
      expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(0);
    }, 60_000);

    it('⭐ X > chegara — 400: outbox, settlement va buyurtma o`zgarmaydi (atomik)', async () => {
      await addOrder('7001', 250000);

      await expect(
        lifecycle.sellOrder(COURIER, '7001', { paidAmount: 205001 }, 'sell-x'),
      ).rejects.toBeDefined();

      expect(await relay()).toBe(0);
      expect(await settlementRow('7001')).toBeUndefined();
      expect(await order('7001')).toMatchObject({
        status: Order_status.WAITING,
        paid_amount: 0,
        sale_market_paid_amount: null,
      });
      await assertInvariants();
    });

    it('takroriy so`rov (bir xil buyurtma) — ikkinchi sotuv 400, kassa ikki marta yozilmaydi', async () => {
      await addOrder('7001', 250000);
      await sell('7001', { paidAmount: 100000 }, 'sell-a');

      await expect(
        lifecycle.sellOrder(COURIER, '7001', { paidAmount: 100000 }, 'sell-b'),
      ).rejects.toBeDefined();
      expect(await relay()).toBe(0);

      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(105000);
      expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(120000);
      await assertInvariants();
    });

    it('⭐ superadmin rollback (PARTLY_PAID, kuryer hali topshirmagan) — barcha kassalar 0, daftar bo`sh', async () => {
      await addOrder('7001', 250000);
      await sell('7001', { paidAmount: 100000 }, 'sell-a');

      await lifecycle.rollbackOrderToWaiting(
        SUPERADMIN,
        '7001',
        undefined,
        'rb-a',
      );
      await relay();
      await assertInvariants();

      expect(await order('7001')).toMatchObject({
        status: Order_status.WAITING,
        paid_amount: 0,
        sale_market_paid_amount: null,
      });
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(0);
      expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(0);

      // Qayta (X siz) sotuv — oddiy SOLD, identiklik saqlanadi.
      await sell('7001', {}, 'sell-b');
      expect(await order('7001')).toMatchObject({ status: Order_status.SOLD });
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(205000);
    }, 60_000);
  },
);
