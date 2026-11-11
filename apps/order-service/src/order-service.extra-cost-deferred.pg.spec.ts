/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { defer, from, of } from 'rxjs';
import { DataSource, In } from 'typeorm';
import {
  Cashbox_type,
  IdempotencyKey,
  Order_status,
  OutboxEvent,
  OutboxService,
  PaymentMethod,
} from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';
import {
  EXTRA_COST_CLOSE_REASON,
  OrderLifecycleService,
} from './lifecycle/order-lifecycle.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { FinanceServiceService } from '../../finance-service/src/finance-service.service';
import { Cashbox } from '../../finance-service/src/entities/cashbox.entity';
import { CashboxHistory } from '../../finance-service/src/entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../../finance-service/src/entities/financial-balance-history.entity';
import { Shift } from '../../finance-service/src/entities/shift.entity';

/**
 * (SPEC v2) Kechiktirilgan qo'shimcha xarajat — PUL INVARIANTI, HAQIQIY
 * Postgres zanjirida (order-service sotuv/bekor/tasdiq tranzaksiyalari,
 * haqiqiy outbox, finance `updateBalance` / `recordFinancialBalance` /
 * `paymentsFromCourier` (filialga) / `paymentFromBranchToMain` /
 * `paymentsToMarket` + market buyurtmalari FIFO'si, settlement FIFO va
 * qoldiqlar (`order_settlement_carry`)).
 *
 * INVARIANT: kechiktirilgan E TASDIQLANSA — har bir kassa qoldig'i,
 * settlement yig'indisi, qoldiq (carry), daftar (P&L) va buyurtma pul
 * ustunlari BUGUNGI «tasdiqsiz E» bilan AYNAN bir xil (oraliqda nima
 * bo'lgan bo'lishidan qat'i nazar). RAD etilsa — E = 0 bilan bir xil.
 * Kutilayotganda — E hech qayerda yo'q.
 *
 * crit-money raqamlari: C = 200 000, T (market tarifi) = 30 000, S (kuryer
 * ulushi) = 0, B (hamkor filial ulushi) = 10 000, E = 20 000, filial kuryeri.
 * Ssenariylar: (a) topshirishdan oldin tasdiq; (b) kuryer 200 000 ni to'liq
 * topshirgandan keyin tasdiq (+ keyingi sotuv); (b′) kuryer E ni ushlab
 * 180 000 topshiradi, keyin tasdiq (turtki); (c) kuryer va filial
 * topshirgandan keyin tasdiq; (d) HQ marketga to'lagandan keyin tasdiq
 * (ortiqcha → keyingi buyurtma); (i) bekor qilish + E.
 *
 * Faqat lokal test bazasi (EXTRA_COST_DEFERRED_PG_TEST_URI,
 * .../elchi_xc_deferred_test) berilsa ishlaydi; o'z sxemalarini yaratadi.
 */
const uri = process.env.EXTRA_COST_DEFERRED_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_xc_deferred_test'
  );
})();

type Row = Record<string, any>;

const MARKET_ID = '501';
const COURIER_ID = '301';
const BRANCH_ID = '15';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: null };
const MARKET_OWNER = { id: MARKET_ID, roles: ['market'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

const C = 200_000;
const T = 30_000;
const B = 10_000;
const E = 20_000;
/** Ikkinchi (E siz) buyurtma — kuryer kreditini yopish uchun. */
const C2 = 100_000;

type Snapshot = {
  cashboxes: Record<string, number>;
  ledger: Record<string, number>;
  settlement: Record<
    string,
    { courier: number; branch: number; market: number }
  >;
  unsettled: string[];
  carries: Record<string, number>;
  orders: Record<string, Row>;
};

(localTestDatabase ? describe : describe.skip)(
  'SPEC v2 — kechiktirilgan qo`shimcha xarajat: pul invarianti (haqiqiy Postgres, pg)',
  () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
    const orderSchema = `spec_xcd_order_${suffix}`;
    const financeSchema = `spec_xcd_fin_${suffix}`;
    let admin: DataSource;
    let orderDb: DataSource;
    let financeDb: DataSource;
    let lifecycle: OrderLifecycleService & Row;
    let settlement: OrderSettlementService;
    let finance: FinanceServiceService;
    /** finance outbox'i (settlement advance) — relay'da order-service'ga. */
    const financeAdvances: Row[] = [];
    /** `advanceSettlement` javoblari (takrorsiz `settled_order_ids` uchun). */
    const advanceResults: Row[] = [];
    /**
     * finance → order-service `order.extra_cost.apply_overage` chaqiruvlari va
     * sun'iy nosozliklar: `before` — qo'llashdan OLDIN RpcException (rmqSend
     * qayta urinmaydi); `after` — qo'llangandan KEYIN javob yo'qoladi (oddiy
     * xato, rmqSend o'zi qayta urinadi — har urinish bittadan kamaytiradi).
     */
    const overageCalls: Row[] = [];
    const overageFault = { before: 0, after: 0 };
    /** Market sozlamasi va kuryer tarifi — har ishga tushirishda. */
    const world = { approvalRequired: true, courierCenterTariff: 0 };

    /**
     * finance → order-service RPC'lari HAQIQIY order bazasida: market
     * buyurtmalari FIFO'si (`order.find_all`) va to'lov holati
     * (`order.update_normalized`). Qolganlari — bo'sh javob.
     */
    const orderRpc = async (pattern: { cmd: string }, payload: Row) => {
      if (pattern.cmd === 'order.find_all') {
        const query = payload?.query ?? {};
        const statuses = (
          Array.isArray(query.status) ? query.status : [query.status]
        ).map(String);
        const dir = query.sort_dir === 'desc' ? 'DESC' : 'ASC';
        const limit = Number(query.limit ?? 100);
        const offset = (Number(query.page ?? 1) - 1) * limit;
        const rows: Row[] = await orderDb.query(
          `SELECT id::text AS id, status::text AS status,
                  to_be_paid::float8 AS to_be_paid,
                  paid_amount::float8 AS paid_amount,
                  extra_cost::float8 AS extra_cost
           FROM "${orderSchema}".orders
           WHERE market_id = $1 AND is_deleted = false
             AND status::text = ANY($2::text[])
           ORDER BY "createdAt" ${dir}, id ${dir}
           LIMIT $3 OFFSET $4`,
          [String(query.market_id), statuses, limit, offset],
        );
        return { statusCode: 200, data: rows };
      }
      if (pattern.cmd === 'order.extra_cost.apply_overage') {
        overageCalls.push(payload);
        if (overageFault.before > 0) {
          overageFault.before -= 1;
          throw new RpcException({
            statusCode: 500,
            message: 'order-service: DB xatosi',
          });
        }
        const res = await lifecycle.applyDeferredExtraCostOverage(payload);
        if (overageFault.after > 0) {
          overageFault.after -= 1;
          throw new Error('javob yo`qoldi (timeout)');
        }
        return res;
      }
      if (pattern.cmd === 'order.update_normalized') {
        const dto = payload?.dto ?? {};
        await orderDb.query(
          `UPDATE "${orderSchema}".orders
           SET paid_amount = COALESCE($2, paid_amount),
               status = COALESCE($3::text, status::text)::"${orderSchema}".orders_status_enum
           WHERE id = $1`,
          [String(payload.id), dto.paid_amount ?? null, dto.status ?? null],
        );
        return { statusCode: 200, data: {} };
      }
      return { statusCode: 200, data: {} };
    };

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
          OrderExtraCostApproval,
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
        // Filial → HQ to'lovi filial smenasini o'qiydi (darvoza o'chiq).
        entities: [Cashbox, CashboxHistory, FinancialBalanceHistory, Shift],
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
        {
          send: jest.fn((pattern: { cmd: string }, payload: Row) =>
            defer(() => from(orderRpc(pattern, payload))),
          ),
        } as never,
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
      jest
        .spyOn(finance as never, 'tryPublishAdvanceNow')
        .mockResolvedValue(undefined as never);

      const lookup = {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn(() =>
          Promise.resolve([
            {
              id: MARKET_ID,
              tariff_center: T,
              tariff_home: 50_000,
              expense_proof_conditions: [],
              extra_cost_enabled: true,
              extra_cost_requires_approval: world.approvalRequired,
            },
          ]),
        ),
        getCouriersByIds: jest.fn((ids: string[]) =>
          Promise.resolve(
            ids.map((id) => ({
              id,
              tariff_center: world.courierCenterTariff,
              tariff_home: 50_000,
              can_add_extra_cost: true,
              can_sell_cancel: true,
            })),
          ),
        ),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn(async (userId: string, type: Cashbox_type) =>
          financeDb.getRepository(Cashbox).findOne({
            where: { user_id: String(userId), cashbox_type: type },
          }),
        ),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        // Filial kuryeri: hamkor filial 15, ulushi B.
        resolveSettlementBranchId: jest.fn().mockResolvedValue(BRANCH_ID),
        resolveBranchShare: jest.fn().mockResolvedValue(B),
        // Superadmin rollback'ida kuryer krediti — kuryer filiali.
        getBranchAssignmentByUserStrict: jest
          .fn()
          .mockResolvedValue({ branch_id: BRANCH_ID }),
      };

      settlement = new OrderSettlementService(
        orderDb,
        orderDb.getRepository(OrderSettlement),
        {} as never,
        lookup as never,
      );

      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Row;
      Object.assign(instance, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        dataSource: orderDb,
        orderRepo: orderDb.getRepository(Order),
        orderSettlementRepo: orderDb.getRepository(OrderSettlement),
        extraCostApprovalRepo: orderDb.getRepository(OrderExtraCostApproval),
        outbox: new OutboxService(orderDb.getRepository(OutboxEvent)),
        lookup,
        logisticsClient: {
          send: jest.fn(() =>
            of({ data: { id: '9001', courier_id: COURIER_ID } }),
          ),
        },
        identityClient: { send: jest.fn(() => of({ data: [] })) },
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
        // Tasdiqsiz market (bazaviy ishga tushirish) — eski 202 so'rovi
        // ochilmaydi; kechiktirilgan rejimda bu chaqirilmaydi.
        requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
        // Tasdiqdan keyingi turtki — HAQIQIY settlement servisi.
        settlementService: settlement,
      });
      lifecycle = instance;
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

    const reset = async (opts: {
      approvalRequired: boolean;
      courierCenterTariff?: number;
    }) => {
      world.approvalRequired = opts.approvalRequired;
      world.courierCenterTariff = opts.courierCenterTariff ?? 0;
      financeAdvances.length = 0;
      advanceResults.length = 0;
      overageCalls.length = 0;
      overageFault.before = 0;
      overageFault.after = 0;
      // Ortiqcha hodisasining (jarayondagi) takror kalitlari — har ishga
      // tushirishda so'rov id lari 1 dan boshlanadi.
      (finance as unknown as Row).extraCostOverageRuns.clear();
      await orderDb.query(
        `TRUNCATE "${orderSchema}".orders, "${orderSchema}".order_settlement,
          "${orderSchema}".order_settlement_carry, "${orderSchema}".outbox_events,
          "${orderSchema}".order_extra_cost_approvals,
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
      await seedCashbox(BRANCH_ID, Cashbox_type.BRANCH);
    };

    const addOrder = (id: string, total: number) =>
      orderDb.query(
        `INSERT INTO "${orderSchema}".orders
          (id, market_id, customer_id, status, source, total_price,
           where_deliver, holder_type, holder_courier_id, courier_id, post_id)
         VALUES ($1, $2, 801, 'waiting', 'internal', $3, 'center', 'COURIER',
                 $4, $4, 9001)`,
        [id, MARKET_ID, total, COURIER_ID],
      );

    /** Fondagi finance ishlari (market buyurtmalari sinxroni) tugashi. */
    const drainFinance = async () => {
      for (let i = 0; i < 5; i += 1) {
        const pending = [
          ...((finance as unknown as Row).pendingFollowUps as Set<
            Promise<void>
          >),
        ];
        if (!pending.length) return;
        await Promise.allSettled(pending);
      }
    };

    /**
     * Outbox relay: kutilayotgan finance hodisalari TARTIB bilan. `hold`
     * berilsa — shu pattern'li hodisalar navbatda qoldiriladi, qolganlari
     * yuboriladi (haqiqiy relay ham xato bergan hodisani keyinga surib,
     * keyingilarini yuboradi — poyga ssenariylari uchun).
     */
    const relay = async (hold?: string) => {
      const rows: Array<{ id: string; pattern: string; payload: Row }> =
        await orderDb.query(
          `SELECT id, pattern, payload FROM "${orderSchema}".outbox_events
           WHERE status = 'pending' ORDER BY id`,
        );
      let relayed = 0;
      for (const row of rows) {
        if (hold && row.pattern === hold) continue;
        relayed += 1;
        if (row.pattern === 'finance.cashbox.update_balance') {
          await finance.updateBalance(row.payload as never);
        } else if (row.pattern === 'finance.financial_balance.record') {
          await finance.recordFinancialBalance(row.payload as never);
        } else if (row.pattern === 'finance.market.extra_cost_overage') {
          await finance.scheduleExtraCostOverageSync(row.payload);
        }
        await orderDb.query(
          `UPDATE "${orderSchema}".outbox_events SET status = 'sent' WHERE id = $1`,
          [row.id],
        );
      }
      return relayed;
    };

    const balance = async (user_id: string, cashbox_type: Cashbox_type) =>
      Number(
        (
          await financeDb
            .getRepository(Cashbox)
            .findOneByOrFail({ user_id, cashbox_type })
        ).balance,
      );

    /**
     * Har qadamdan keyin: market kassasi == Σ market_amount (market_settled
     * emas) − market qoldig'i (`hq_to_market`: to'langan, lekin hali qator
     * yopmagan summa), kassa == o'z tarixi, kuryer kassasi == Σ PENDING
     * courier_amount − kuryer qoldig'i.
     */
    const assertInvariants = async () => {
      const marketRecon: Row[] = await admin.query(
        `SELECT cb.user_id AS market_id,
                cb.balance::float8 AS cashbox_balance,
                COALESCE((
                  SELECT SUM(os.market_amount) FROM "${orderSchema}".order_settlement os
                  WHERE os.is_deleted = false AND os.status <> 'market_settled'
                    AND os.market_id = cb.user_id
                ), 0)::float8 AS unsettled_owed,
                COALESCE((
                  SELECT SUM(c.amount) FROM "${orderSchema}".order_settlement_carry c
                  WHERE c.level = 'hq_to_market'
                    AND c.party_id::text = cb.user_id::text
                ), 0)::float8 AS carry
         FROM "${financeSchema}".cashboxes cb
         WHERE cb.cashbox_type = 'markets' AND cb.is_deleted = false`,
      );
      for (const m of marketRecon) {
        expect({
          market: m.market_id,
          diff: m.cashbox_balance - (m.unsettled_owed - m.carry),
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

    /** finance outbox'idagi settlement siljishlari → order-service FIFO. */
    const settle = async () => {
      for (let i = 0; i < 5; i += 1) {
        await drainFinance();
        const advances = financeAdvances.splice(0);
        for (const payload of advances) {
          advanceResults.push(
            await settlement.advanceSettlement(payload as never),
          );
        }
        const relayed = await relay();
        if (!advances.length && !relayed) break;
      }
      await drainFinance();
      await assertInvariants();
    };

    const snapshot = async (): Promise<Snapshot> => {
      const cashboxes: Row[] = await financeDb.query(
        `SELECT cashbox_type::text AS type, user_id, balance::float8 AS balance
         FROM "${financeSchema}".cashboxes WHERE is_deleted = false`,
      );
      const ledger: Row[] = await financeDb.query(
        `SELECT source_type::text AS kind, SUM(amount)::float8 AS amount
         FROM "${financeSchema}".financial_balance_history GROUP BY 1`,
      );
      const settlementRows: Row[] = await orderDb.query(
        `SELECT order_id::text AS order_id,
                SUM(courier_amount)::float8 AS courier,
                SUM(branch_amount)::float8 AS branch,
                SUM(market_amount)::float8 AS market
         FROM "${orderSchema}".order_settlement WHERE is_deleted = false
         GROUP BY 1`,
      );
      const unsettled: Row[] = await orderDb.query(
        `SELECT order_id::text AS order_id, status::text AS status
         FROM "${orderSchema}".order_settlement
         WHERE is_deleted = false AND status <> 'market_settled'
         ORDER BY 1, 2`,
      );
      const carries: Row[] = await orderDb.query(
        `SELECT level, party_id::text AS party_id, amount::float8 AS amount
         FROM "${orderSchema}".order_settlement_carry WHERE amount <> 0`,
      );
      const orders: Row[] = await orderDb.query(
        `SELECT id::text AS id, status::text AS status,
                to_be_paid::float8 AS to_be_paid,
                paid_amount::float8 AS paid_amount,
                extra_cost::float8 AS extra_cost,
                sale_market_paid_amount::float8 AS sale_market_paid_amount
         FROM "${orderSchema}".orders ORDER BY id`,
      );
      return {
        cashboxes: Object.fromEntries(
          cashboxes.map((c) => [`${c.type}:${c.user_id}`, Number(c.balance)]),
        ),
        ledger: Object.fromEntries(
          ledger.map((l) => [l.kind, Number(l.amount)]),
        ),
        settlement: Object.fromEntries(
          settlementRows.map((s) => [
            s.order_id,
            {
              courier: Number(s.courier),
              branch: Number(s.branch),
              market: Number(s.market),
            },
          ]),
        ),
        unsettled: unsettled.map((u) => `${u.order_id}:${u.status}`),
        carries: Object.fromEntries(
          carries.map((c) => [`${c.level}:${c.party_id}`, Number(c.amount)]),
        ),
        orders: Object.fromEntries(
          orders.map((o) => [
            o.id,
            {
              status: o.status,
              to_be_paid: Number(o.to_be_paid),
              paid_amount: Number(o.paid_amount),
              extra_cost: Number(o.extra_cost),
              sale_market_paid_amount: o.sale_market_paid_amount,
            },
          ]),
        ),
      };
    };

    // ---- Amallar ----
    const sell = async (id: string, total: number, extraCost: number) => {
      await addOrder(id, total);
      const res = (await lifecycle.sellOrder(
        COURIER,
        id,
        extraCost > 0 ? { extraCost } : {},
        `sell-${id}`,
      )) as { statusCode?: number; data: Row };
      await settle();
      return res;
    };
    const cancel = async (id: string, total: number, extraCost: number) => {
      await addOrder(id, total);
      const res = (await lifecycle.cancelOrder(
        COURIER,
        id,
        { comment: 'Mijoz rad etdi', ...(extraCost > 0 ? { extraCost } : {}) },
        `cancel-${id}`,
      )) as { statusCode?: number; data: Row };
      await settle();
      return res;
    };
    let token = 0;
    const courierToBranch = async (amount: number) => {
      await finance.paymentsFromCourier({
        courier_id: COURIER_ID,
        amount,
        payment_method: PaymentMethod.CASH,
        created_by: '15001',
        receiver_user_id: BRANCH_ID,
        receiver_cashbox_type: Cashbox_type.BRANCH,
        dedup_epoch: `courier-${++token}`,
      });
      await settle();
    };
    const branchToHq = async (amount: number) => {
      await finance.paymentFromBranchToMain({
        branch_id: BRANCH_ID,
        amount,
        payment_method: PaymentMethod.CASH,
        created_by: '15001',
        dedup_epoch: `branch-${++token}`,
      });
      await settle();
    };
    const hqToMarket = async (amount: number) => {
      await finance.paymentsToMarket({
        market_id: MARKET_ID,
        amount,
        payment_method: PaymentMethod.CASH,
        created_by: '1',
        dedup_epoch: `market-${++token}`,
      });
      await settle();
    };
    const pendingDeferredId = async () => {
      const rows: Row[] = await orderDb.query(
        `SELECT id::text AS id FROM "${orderSchema}".order_extra_cost_approvals
         WHERE mode = 'deferred' AND status = 'pending' ORDER BY id DESC LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      return String(rows[0].id);
    };
    const approve = async () => {
      const res = (await lifecycle.approveExtraCostApproval(
        MARKET_OWNER,
        await pendingDeferredId(),
      )) as { data: Row };
      await settle();
      return res;
    };
    const reject = async () => {
      await lifecycle.rejectExtraCostApproval(
        MARKET_OWNER,
        await pendingDeferredId(),
        { comment: 'Kelishilmagan' },
      );
      await settle();
    };

    const run = async (
      opts: { approvalRequired: boolean; courierCenterTariff?: number },
      steps: () => Promise<void>,
    ) => {
      await reset(opts);
      token = 0;
      await steps();
      return snapshot();
    };

    /** Kechiktirilgan sotuv javobi — 200, `extra_cost_request` pending. */
    const expectDeferred = (res: { statusCode?: number; data: Row }) => {
      expect(res.statusCode).not.toBe(202);
      expect(res.data?.approval_required).toBeUndefined();
      expect(res.data?.extra_cost_request).toMatchObject({
        status: 'pending',
        mode: 'deferred',
        amount: E,
      });
    };

    /** Kutilayotgan E — hech qayerda yo'q (E = 0 sotuv/bekor bilan teng). */
    const expectNothingOfE = async (orderId: string) => {
      const [order] = await orderDb.query<Row[]>(
        `SELECT extra_cost::float8 AS extra_cost FROM "${orderSchema}".orders WHERE id = $1`,
        [orderId],
      );
      expect(Number(order.extra_cost)).toBe(0);
      const ledger: Row[] = await financeDb.query(
        `SELECT COUNT(*)::int AS n FROM "${financeSchema}".financial_balance_history
         WHERE source_type::text IN ('sell_extra_cost', 'cancel_extra_cost')`,
      );
      expect(ledger[0].n).toBe(0);
      const history: Row[] = await financeDb.query(
        `SELECT COUNT(*)::int AS n FROM "${financeSchema}".cashbox_history
         WHERE source_type::text = 'extra_cost'`,
      );
      expect(history[0].n).toBe(0);
      const extraRows: Row[] = await orderDb.query(
        `SELECT COUNT(*)::int AS n FROM "${orderSchema}".order_settlement
         WHERE kind <> 'sale'`,
      );
      expect(extraRows[0].n).toBe(0);
    };

    /** Bitta buyurtma: tasdiqsiz E bilan bugungi to'liq zanjir. */
    const baselineOneOrder = () =>
      run({ approvalRequired: false }, async () => {
        await sell('7001', C, E);
        await courierToBranch(C - E);
        await branchToHq(C - B - E);
        await hqToMarket(C - T - E);
      });

    /** Ikki buyurtma (ikkinchisi E siz): tasdiqsiz E bilan bugungi zanjir. */
    const baselineTwoOrders = () =>
      run({ approvalRequired: false }, async () => {
        await sell('7001', C, E);
        await sell('7002', C2, 0);
        await courierToBranch(C - E + C2);
        await branchToHq(C - B - E + (C2 - B));
        await hqToMarket(C - T - E + (C2 - T));
      });

    it('bazaviy (tasdiqsiz E) raqamlari — crit-money §0', async () => {
      const base = await baselineOneOrder();
      expect(base.cashboxes).toEqual({
        [`${Cashbox_type.MAIN}:0`]: E, // T − B = 20 000 HQ'da
        [`${Cashbox_type.BRANCH}:${BRANCH_ID}`]: B,
        [`${Cashbox_type.FOR_COURIER}:${COURIER_ID}`]: 0,
        [`${Cashbox_type.FOR_MARKET}:${MARKET_ID}`]: 0,
      });
      expect(base.settlement).toEqual({
        '7001': { courier: 180_000, branch: 170_000, market: 150_000 },
      });
      expect(base.unsettled).toEqual([]);
      expect(base.carries).toEqual({});
      expect(base.ledger.sell_extra_cost).toBe(-E);
      expect(base.orders['7001']).toMatchObject({
        status: Order_status.PAID,
        to_be_paid: 170_000,
        paid_amount: 170_000,
        extra_cost: E,
      });
    }, 120_000);

    it('⭐ (a) tasdiq kuryer topshirishidan OLDIN — yakun bugungi «tasdiqsiz E» bilan AYNAN', async () => {
      const base = await baselineOneOrder();
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await expectNothingOfE('7001');
        const approved = await approve();
        expect(approved.data.operation).toMatchObject({
          mode: 'deferred',
          extra_cost: E,
          status: Order_status.SOLD,
          overage: 0,
        });
        // Ikki yangi settlement qatori: zanjir (−E/−E/0) va market (0/0/−E).
        const rows: Row[] = await orderDb.query(
          `SELECT kind, status::text AS status, courier_amount::float8 AS c,
                  branch_amount::float8 AS b, market_amount::float8 AS m
           FROM "${orderSchema}".order_settlement WHERE kind <> 'sale' ORDER BY kind`,
        );
        expect(rows).toEqual([
          { kind: 'extra_cost_chain', status: 'pending', c: -E, b: -E, m: 0 },
          {
            kind: 'extra_cost_market',
            status: 'branch_settled',
            c: 0,
            b: 0,
            m: -E,
          },
        ]);
        await courierToBranch(C - E);
        await branchToHq(C - B - E);
        await hqToMarket(C - T - E);
      });
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ (b) kuryer 200 000 ni to`liq topshirgach tasdiq, keyin keyingi sotuv — yakun AYNAN', async () => {
      const base = await baselineTwoOrders();
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C);
        await approve();
        // Kuryer kassasi −E — keyingi sotuvdan qoplanadi.
        expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(-E);
        await sell('7002', C2, 0);
        await courierToBranch(C2 - E);
        await branchToHq(C - B + (C2 - B) - E);
        await hqToMarket(C - T - E + (C2 - T));
      });
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ (b′) kuryer E ni ushlab 180 000 topshiradi, keyin tasdiq — turtki qatorlarni yopadi, yakun AYNAN', async () => {
      const base = await baselineOneOrder();
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C - E);
        // Tasdiqgacha sotuv qatori (200 000) qoldiq 180 000 bilan yopilmaydi.
        expect((await snapshot()).carries).toEqual({
          [`courier_to_branch:${COURIER_ID}`]: C - E,
        });
        await approve();
        // Turtki: qoldiq + zanjir krediti — ikkala qator COURIER_SETTLED.
        const after = await snapshot();
        expect(after.carries).toEqual({});
        expect(after.unsettled).toEqual([
          '7001:branch_settled',
          '7001:courier_settled',
          '7001:courier_settled',
        ]);
        await branchToHq(C - B - E);
        await hqToMarket(C - T - E);
      });
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ (c) kuryer va filial topshirgach tasdiq — market oyog`i darhol ishlatiladi, yakun AYNAN', async () => {
      const base = await baselineTwoOrders();
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C);
        await branchToHq(C - B);
        await approve();
        // HQ marketga kassadagini to'laydi — market qatori (BRANCH_SETTLED)
        // sotuv qatori bilan birga yopiladi, qoldiq yo'q.
        await hqToMarket(C - T - E);
        const mid = await snapshot();
        expect(mid.carries).toEqual({});
        expect(mid.orders['7001']).toMatchObject({
          status: Order_status.PAID,
          paid_amount: C - T,
          extra_cost: E,
        });
        await sell('7002', C2, 0);
        await courierToBranch(C2 - E);
        await branchToHq(C2 - B - E);
        await hqToMarket(C2 - T);
      });
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ (d) HQ marketga to`lagandan keyin tasdiq — ortiqcha keyingi buyurtmaga, yakun AYNAN', async () => {
      const base = await baselineTwoOrders();
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C);
        await branchToHq(C - B);
        await hqToMarket(C - T);
        await sell('7002', C2, 0);
        const approved = await approve();
        expect(approved.data.operation).toMatchObject({
          status: Order_status.PAID,
          overage: E,
        });
        // Ortiqcha (pul ko'chmasdan) keyingi buyurtmaga: 7002 qisman to'langan.
        const mid = await snapshot();
        expect(mid.orders['7001']).toMatchObject({
          status: Order_status.PAID,
          paid_amount: C - T,
          extra_cost: E,
        });
        expect(mid.orders['7002']).toMatchObject({
          status: Order_status.PARTLY_PAID,
          paid_amount: E,
        });
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(
          C2 - T - E,
        );
        await courierToBranch(C2 - E);
        await branchToHq(C2 - B - E);
        await hqToMarket(C2 - T - E);
      });
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ (i) bekor qilish + E — tasdiqdan keyin yakun bugungi «tasdiqsiz E» bilan AYNAN', async () => {
      // Bekor qilishda E kuryerning o'z markaz tarifidan oshmasligi kerak —
      // shu ssenariyda kuryer markaz tarifi 20 000 (S = 20 000).
      const S = 20_000;
      const steps = (deferredMode: boolean) => async () => {
        const res = await cancel('7001', C, E);
        if (deferredMode) {
          expect(res.data?.extra_cost_request).toMatchObject({
            status: 'pending',
            mode: 'deferred',
            action: 'cancel',
            amount: E,
          });
          await expectNothingOfE('7001');
          await approve();
        }
        await sell('7002', C2, 0);
        await courierToBranch(C2 - S - E);
        await branchToHq(C2 - S - B - E);
        await hqToMarket(C2 - T - E);
      };
      const base = await run(
        { approvalRequired: false, courierCenterTariff: S },
        steps(false),
      );
      expect(base.unsettled).toEqual([]);
      expect(base.ledger.cancel_extra_cost).toBe(-E);
      expect(base.orders['7001']).toMatchObject({
        status: Order_status.CANCELLED,
        extra_cost: E,
      });
      const deferred = await run(
        { approvalRequired: true, courierCenterTariff: S },
        steps(true),
      );
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ rad etish — kutilayotganda E yo`q, rad etilgach yakun E = 0 sotuv bilan AYNAN', async () => {
      let zeroAfterSale: Snapshot | null = null;
      const zero = await run({ approvalRequired: true }, async () => {
        await sell('7001', C, 0);
        zeroAfterSale = await snapshot();
        await courierToBranch(C);
        await branchToHq(C - B);
        await hqToMarket(C - T);
      });
      const rejected = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        // Kutilmoqda: hamma narsa E = 0 sotuv bilan bir xil.
        expect(await snapshot()).toEqual(zeroAfterSale);
        await courierToBranch(C);
        await reject();
        await branchToHq(C - B);
        await hqToMarket(C - T);
      });
      expect(rejected).toEqual(zero);
      expect(rejected.orders['7001']).toMatchObject({
        status: Order_status.PAID,
        extra_cost: 0,
      });
    }, 120_000);

    // ---- Rollback (SPEC v2 §5) ----
    const rollback = async (
      requester: { id: string; roles: string[]; branch_id?: string | null },
      id: string,
    ) => {
      await lifecycle.rollbackOrderToWaiting(
        requester,
        id,
        undefined,
        `rb-${id}-${++token}`,
      );
      await settle();
    };
    const approvalStatus = async (orderId: string) =>
      (
        await orderDb.query<Row[]>(
          `SELECT status FROM "${orderSchema}".order_extra_cost_approvals
           WHERE order_id = $1 AND mode = 'deferred'`,
          [orderId],
        )
      ).map((row) => row.status);
    const zeroCashboxes = {
      [`${Cashbox_type.MAIN}:0`]: 0,
      [`${Cashbox_type.BRANCH}:${BRANCH_ID}`]: 0,
      [`${Cashbox_type.FOR_COURIER}:${COURIER_ID}`]: 0,
      [`${Cashbox_type.FOR_MARKET}:${MARKET_ID}`]: 0,
    };

    it('⭐ rollback: kutilayotgan E — so`rov void, pul yo`q, kassalar 0', async () => {
      const after = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await rollback(COURIER, '7001');
      });
      expect(await approvalStatus('7001')).toEqual(['void']);
      expect(after.cashboxes).toEqual(zeroCashboxes);
      expect(after.settlement).toEqual({});
      expect(after.orders['7001']).toMatchObject({
        status: Order_status.WAITING,
        extra_cost: 0,
      });
    }, 120_000);

    it('⭐ rollback: tasdiqlangan, ishlatilmagan E — bugungi «tasdiqsiz E» rollback bilan AYNAN; so`rov reversed', async () => {
      const base = await run({ approvalRequired: false }, async () => {
        await sell('7001', C, E);
        await rollback(COURIER, '7001');
      });
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await approve();
        await rollback(COURIER, '7001');
      });
      expect(await approvalStatus('7001')).toEqual(['reversed']);
      expect(deferred).toEqual(base);
      expect(deferred.cashboxes).toEqual(zeroCashboxes);
      expect(deferred.settlement).toEqual({});
      expect(deferred.orders['7001']).toMatchObject({
        status: Order_status.WAITING,
        extra_cost: 0,
      });
    }, 120_000);

    it('⭐ rollback: E krediti boshqa buyurtma topshirig`ida ishlatilgan — 400, hech narsa o`zgarmaydi', async () => {
      await run({ approvalRequired: true }, async () => {
        await sell('7000', C2, 0);
        expectDeferred(await sell('7001', C, E));
        await approve();
        // 7000 (100 000) 80 000 ga sig'maydi — 7001 ning zanjir krediti
        // tortiladi; 7001 sotuv qatori esa PENDING qoladi.
        await courierToBranch(C2 - E);
        const rows: Row[] = await orderDb.query(
          `SELECT order_id::text AS order_id, kind, status::text AS status
           FROM "${orderSchema}".order_settlement ORDER BY order_id, kind`,
        );
        expect(rows).toEqual([
          { order_id: '7000', kind: 'sale', status: 'courier_settled' },
          {
            order_id: '7001',
            kind: 'extra_cost_chain',
            status: 'courier_settled',
          },
          {
            order_id: '7001',
            kind: 'extra_cost_market',
            status: 'branch_settled',
          },
          { order_id: '7001', kind: 'sale', status: 'pending' },
        ]);
        const before = await snapshot();
        await expect(
          lifecycle.rollbackOrderToWaiting(
            COURIER,
            '7001',
            undefined,
            'rb-used',
          ),
        ).rejects.toMatchObject({
          error: expect.objectContaining({
            message: expect.stringMatching(
              /Qo'shimcha xarajat krediti boshqa buyurtma hisob-kitobida ishlatilgan/,
            ),
          }),
        });
        await settle();
        expect(await snapshot()).toEqual(before);
        expect(await approvalStatus('7001')).toEqual(['approved']);
      });
    }, 120_000);

    it('⭐ rollback (superadmin): kuryer topshirgan + tasdiqlangan E — kassa qaytimi −(sotuv + zanjir), qoldiqqa sotuv summasi', async () => {
      const after = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C);
        await approve();
        expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(-E);
        await rollback(SUPERADMIN, '7001');
      });
      expect(await approvalStatus('7001')).toEqual(['reversed']);
      // Kassa: −E − 200 000 (sotuv) + E (xarajat qaytdi) = −200 000;
      // qoldiq (kredit) — sotuv qatori summasi 200 000, zanjir qatori o'chdi.
      expect(after.cashboxes[`${Cashbox_type.FOR_COURIER}:${COURIER_ID}`]).toBe(
        -C,
      );
      expect(after.carries).toEqual({ [`courier_to_branch:${COURIER_ID}`]: C });
      expect(after.settlement).toEqual({});
      expect(after.cashboxes[`${Cashbox_type.FOR_MARKET}:${MARKET_ID}`]).toBe(
        0,
      );
      expect(after.orders['7001']).toMatchObject({
        status: Order_status.WAITING,
        extra_cost: 0,
      });
    }, 120_000);

    it('⭐ kuryer o`tkazish tekshiruvi: kechiktirilgan so`rov buyurtma holatidan qat`i nazar sanaladi; E krediti «N ta sotuv» ga kirmaydi', async () => {
      await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await courierToBranch(C);
        const check = async () =>
          (
            (await settlement.getCourierTransferCheck({
              courier_id: COURIER_ID,
            })) as { data: Row }
          ).data;
        // Buyurtma SOLD (kutilmoqda emas) — baribir kuryerni to'sadi.
        expect(await check()).toMatchObject({
          pending_extra_cost_approvals: 1,
          pending_settlement_count: 0,
        });
        await approve();
        // Tasdiqdan keyin: so'rov yopildi; zanjir krediti (−E, PENDING)
        // summada bor, lekin sotuvlar sonida emas.
        expect(await check()).toMatchObject({
          pending_extra_cost_approvals: 0,
          pending_settlement_count: 0,
          pending_settlement_amount: -E,
        });
      });
    }, 120_000);

    // ---- Review tuzatishlari (SPEC v2) ----
    const settlementRows = async (orderId?: string): Promise<Row[]> =>
      orderDb.query(
        `SELECT order_id::text AS order_id, kind, status::text AS status,
                market_amount::float8 AS m
         FROM "${orderSchema}".order_settlement
         WHERE is_deleted = false ${orderId ? 'AND order_id = $1' : ''}
         ORDER BY order_id, kind`,
        orderId ? [orderId] : [],
      );
    /** Market ochiq buyurtmalarining to'lanmagan qismi (SOLD / PARTLY_PAID). */
    const marketRemaining = async () =>
      Number(
        (
          await orderDb.query<Row[]>(
            `SELECT COALESCE(SUM(to_be_paid - paid_amount), 0)::float8 AS s
             FROM "${orderSchema}".orders
             WHERE market_id = $1 AND is_deleted = false
               AND status::text = ANY($2::text[])`,
            [MARKET_ID, [Order_status.SOLD, Order_status.PARTLY_PAID]],
          )
        )[0].s,
      );
    /** Market kassasidagi qo'shimcha xarajat yozuvlari soni (−E necha marta). */
    const marketExtraCostHistory = async () =>
      Number(
        (
          await financeDb.query<Row[]>(
            `SELECT COUNT(*)::int AS n
             FROM "${financeSchema}".cashbox_history h
             JOIN "${financeSchema}".cashboxes cb ON cb.id = h.cashbox_id
             WHERE cb.cashbox_type = 'markets'
               AND h.source_type::text = 'extra_cost'`,
          )
        )[0].n,
      );
    /** Tasdiq — relay'siz (finance hodisalari outbox'da kutib turadi). */
    const approveWithoutRelay = async () =>
      (await lifecycle.approveExtraCostApproval(
        MARKET_OWNER,
        await pendingDeferredId(),
      )) as { data: Row };
    const pendingOutbox = async (): Promise<Row[]> =>
      orderDb.query(
        `SELECT pattern, payload FROM "${orderSchema}".outbox_events
         WHERE status = 'pending' ORDER BY id`,
      );
    /**
     * (d) holati: 7001 ni HQ marketga to'lab bo'lgan, 7002 ochiq (SOLD),
     * tasdiq outbox'da — ortiqcha hodisasining payload'i.
     */
    const overageSetup = async () => {
      expectDeferred(await sell('7001', C, E));
      await courierToBranch(C);
      await branchToHq(C - B);
      await hqToMarket(C - T);
      await sell('7002', C2, 0);
      await approveWithoutRelay();
      const events = (await pendingOutbox()).filter(
        (event) => event.pattern === 'finance.market.extra_cost_overage',
      );
      expect(events).toHaveLength(1);
      return events[0].payload as Row;
    };
    const order7002 = async () => (await snapshot()).orders['7002'];
    const marketCashbox = `${Cashbox_type.FOR_MARKET}:${MARKET_ID}`;

    it('⭐ rollback (superadmin): tasdiqdan KEYIN kuryer C − E topshirdi (sotuv + zanjir krediti birga yopildi) — bugungi «tasdiqsiz E» bilan AYNAN; settled_order_ids takrorsiz', async () => {
      const base = await run({ approvalRequired: false }, async () => {
        await sell('7001', C, E);
        await courierToBranch(C - E);
        await rollback(SUPERADMIN, '7001');
      });
      expect(base.carries).toEqual({
        [`courier_to_branch:${COURIER_ID}`]: C - E,
      });
      expect(base.cashboxes[`${Cashbox_type.FOR_COURIER}:${COURIER_ID}`]).toBe(
        -(C - E),
      );
      const deferred = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await approve();
        await courierToBranch(C - E);
        expect(
          (await settlementRows('7001')).map(
            (row) => `${row.kind}:${row.status}`,
          ),
        ).toEqual([
          'extra_cost_chain:courier_settled',
          'extra_cost_market:branch_settled',
          'sale:courier_settled',
        ]);
        // Bitta topshiriq bitta buyurtmani yopdi (sotuv + zanjir qatori) —
        // ro'yxatda «7001» bir marta.
        const advances = advanceResults.filter((result) =>
          (result.data?.settled_order_ids ?? []).includes('7001'),
        );
        expect(advances.map((result) => result.data.settled_order_ids)).toEqual(
          [['7001']],
        );
        await rollback(SUPERADMIN, '7001');
      });
      expect(await approvalStatus('7001')).toEqual(['reversed']);
      expect(deferred).toEqual(base);
    }, 120_000);

    it('⭐ rollback: E ning market qatori boshqa buyurtmaning HQ → market to`lovida ishlatilgan — teskari qator, rollback o`tadi, yakun bugungi bilan AYNAN', async () => {
      const steps = (deferredMode: boolean) => async () => {
        await sell('7000', C2, 0);
        const res = await sell('7001', C, E);
        if (deferredMode) {
          expectDeferred(res);
          await approve();
        }
        await courierToBranch(C2);
        await branchToHq(C2 - B);
        // 7000 (70 000) ga 50 000 yetmaydi — 7001 ning market krediti (−E)
        // tortiladi va ikkalasi birga yopiladi.
        await hqToMarket(C2 - T - E);
        if (deferredMode) {
          expect(
            (await settlementRows()).map(
              (row) => `${row.order_id}:${row.kind}:${row.status}`,
            ),
          ).toEqual([
            '7000:sale:market_settled',
            '7001:extra_cost_chain:pending',
            '7001:extra_cost_market:market_settled',
            '7001:sale:pending',
          ]);
        }
        await rollback(COURIER, '7001');
        if (deferredMode) {
          expect(await approvalStatus('7001')).toEqual(['reversed']);
          // Ishlatilgan market qatori tarixda qoladi; teskari qator (+E)
          // marketga qarzni qaytaradi.
          expect(await settlementRows('7001')).toEqual([
            {
              order_id: '7001',
              kind: 'extra_cost_market',
              status: 'market_settled',
              m: -E,
            },
            {
              order_id: '7001',
              kind: 'extra_cost_reversal',
              status: 'branch_settled',
              m: E,
            },
          ]);
          const view = (await settlement.getSettlementByOrderId('7001')) as {
            data: Row | null;
          };
          expect(view.data).toBeNull();
        }
        // Marketga qarz: 7000 ning yopilmagan qismi E.
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(E);
        await hqToMarket(E);
      };
      const base = await run({ approvalRequired: false }, steps(false));
      expect(base.unsettled).toEqual([]);
      expect(base.carries).toEqual({});
      const deferred = await run({ approvalRequired: true }, steps(true));
      const { '7001': reversedNet, ...settlementRest } = deferred.settlement;
      expect(reversedNet).toEqual({ courier: 0, branch: 0, market: 0 });
      expect({ ...deferred, settlement: settlementRest }).toEqual(base);
    }, 120_000);

    it('⭐ rollback: oldindan tekshiruvdan keyin E qatori o`zgarsa (parallel HQ → market to`lovi) — qulf ostidagi qayta tekshiruv 400, hech narsa o`zgarmaydi', async () => {
      await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await approve();
        const before = await snapshot();
        const load = (lifecycle as Row).loadDeferredExtraCostRollbackState as (
          ...args: unknown[]
        ) => Promise<unknown>;
        const spy = jest
          .spyOn(lifecycle as Row, 'loadDeferredExtraCostRollbackState')
          .mockImplementationOnce(async function (
            this: unknown,
            ...args: unknown[]
          ) {
            const state = await load.apply(this, args);
            // Tekshiruvdan keyin, tranzaksiyadan oldin: market qatorini
            // parallel to'lov yopdi.
            await orderDb.query(
              `UPDATE "${orderSchema}".order_settlement SET status = 'market_settled'
               WHERE order_id = 7001 AND kind = 'extra_cost_market'`,
            );
            return state;
          });
        try {
          await expect(
            lifecycle.rollbackOrderToWaiting(
              COURIER,
              '7001',
              undefined,
              'rb-race',
            ),
          ).rejects.toMatchObject({
            error: expect.objectContaining({
              message: expect.stringMatching(
                /Rollback holati o'zgargan \(qo'shimcha xarajat hisob-kitobi yangilangan\)/,
              ),
            }),
          });
        } finally {
          spy.mockRestore();
        }
        // Sun'iy o'zgarish qaytariladi — rollback hech narsa yozmagan.
        await orderDb.query(
          `UPDATE "${orderSchema}".order_settlement SET status = 'branch_settled'
           WHERE order_id = 7001 AND kind = 'extra_cost_market'`,
        );
        await settle();
        expect(await snapshot()).toEqual(before);
        expect(await approvalStatus('7001')).toEqual(['approved']);
      });
    }, 120_000);

    it('⭐ ortiqcha poygasi: yangi sotuv tasdiq hodisalaridan oldin, ortiqcha hodisasi oldidan va hammasidan keyin — 7002 ga AYNAN E, Σ qoldiq == FOR_MARKET', async () => {
      for (const relayed of ['none', 'before-overage', 'all'] as const) {
        const after = await run({ approvalRequired: true }, async () => {
          expectDeferred(await sell('7001', C, E));
          await courierToBranch(C);
          await branchToHq(C - B);
          await hqToMarket(C - T);
          const approved = await approveWithoutRelay();
          expect(approved.data.operation).toMatchObject({
            status: Order_status.PAID,
            overage: E,
          });
          const pending = await pendingOutbox();
          // FOR_MARKET −E alohida oyoq EMAS — ortiqcha hodisasi ichida,
          // qo'llashdan KEYIN yoziladi.
          expect(
            pending.filter(
              (event) =>
                event.pattern === 'finance.cashbox.update_balance' &&
                event.payload?.cashbox_type === Cashbox_type.FOR_MARKET,
            ),
          ).toEqual([]);
          const overage = pending.filter(
            (event) => event.pattern === 'finance.market.extra_cost_overage',
          );
          expect(overage).toHaveLength(1);
          expect(overage[0].payload).toMatchObject({
            market_id: MARKET_ID,
            amount: E,
            market_leg: {
              user_id: MARKET_ID,
              cashbox_type: Cashbox_type.FOR_MARKET,
              amount: E,
            },
          });
          if (relayed === 'all') {
            await settle();
            // Ochiq buyurtma yo'q — ortiqcha manfiy balansda (avtomatik
            // to'lov uchun).
            expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(-E);
          } else {
            if (relayed === 'before-overage') {
              // Tasdiqning boshqa hodisalari yetib bordi, ortiqcha hodisasi
              // esa navbatda (kechikdi / xato berdi). Eski oqimda −E alohida
              // oyoq edi va aynan shu yerda tushardi: sotuv uni avtomatik
              // to'lardi, keyin ortiqcha yana E berardi (E ikki marta).
              expect(
                await relay('finance.market.extra_cost_overage'),
              ).toBeGreaterThan(0);
            }
            // −E hali yozilmagan — sotuv manfiy balans ko'rmaydi.
            expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(0);
          }
          await sell('7002', C2, 0);
        });
        expect({ relayed, order: after.orders['7002'] }).toMatchObject({
          relayed,
          order: { status: Order_status.PARTLY_PAID, paid_amount: E },
        });
        expect(after.cashboxes[marketCashbox]).toBe(C2 - T - E);
        expect(await marketRemaining()).toBe(C2 - T - E);
        expect(overageCalls).toHaveLength(1);
        expect(await marketExtraCostHistory()).toBe(1);
      }
    }, 300_000);

    it('⭐ ortiqcha hodisasi: xato → qayta urinish, parallel takror va qayta yuborish — buyurtmaga BIR marta, −E BIR marta', async () => {
      await run({ approvalRequired: true }, async () => {
        const payload = await overageSetup();
        // 1) order-service xatosi (qo'llashdan oldin) — hodisa reject,
        //    hech narsa o'zgarmaydi (outbox qayta yuboradi).
        overageFault.before = 1;
        await expect(
          finance.scheduleExtraCostOverageSync(payload),
        ).rejects.toThrow();
        expect(await order7002()).toMatchObject({
          status: Order_status.SOLD,
          paid_amount: 0,
        });
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(C2 - T);
        // 2) Qayta urinish ikki nusxada parallel — bitta qo'llash, ikkalasiga
        //    bir xil haqiqiy natija.
        const [first, second] = await Promise.all([
          finance.scheduleExtraCostOverageSync(payload),
          finance.scheduleExtraCostOverageSync(payload),
        ]);
        expect(first).toEqual({ applied: true, duplicate: false });
        expect(second).toEqual(first);
        expect(overageCalls).toHaveLength(2);
        expect(await order7002()).toMatchObject({
          status: Order_status.PARTLY_PAID,
          paid_amount: E,
        });
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(
          C2 - T - E,
        );
        // 3) Qayta yuborish (outbox / finance qayta ishga tushgan) — takror.
        await expect(
          finance.scheduleExtraCostOverageSync(payload),
        ).resolves.toEqual({ applied: false, duplicate: true });
        // Qolgan hodisalar (shu ortiqcha hodisasi ham — yana takror).
        await settle();
        expect(await order7002()).toMatchObject({
          status: Order_status.PARTLY_PAID,
          paid_amount: E,
        });
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(
          C2 - T - E,
        );
        expect(await marketRemaining()).toBe(C2 - T - E);
        expect(await marketExtraCostHistory()).toBe(1);
      });
    }, 120_000);

    it('⭐ ortiqcha hodisasi: qo`llangan, lekin javob yo`qolgan — qayta yuborishda takror deb taniladi, −E keyin BIR marta yoziladi', async () => {
      await run({ approvalRequired: true }, async () => {
        const payload = await overageSetup();
        // rmqSend o'zi 2 marta qayta urinadi — uchala urinishda ham javob
        // yo'qoladi (birinchisi qo'llaydi, keyingilari takror).
        overageFault.after = 3;
        await expect(
          finance.scheduleExtraCostOverageSync(payload),
        ).rejects.toThrow();
        expect(overageCalls).toHaveLength(3);
        expect(await order7002()).toMatchObject({
          status: Order_status.PARTLY_PAID,
          paid_amount: E,
        });
        // −E hali yozilmagan (qo'llash javobidan keyin yoziladi).
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(C2 - T);
        await expect(
          finance.scheduleExtraCostOverageSync(payload),
        ).resolves.toEqual({ applied: false, duplicate: true });
        expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(
          C2 - T - E,
        );
        await settle();
        expect(await order7002()).toMatchObject({
          status: Order_status.PARTLY_PAID,
          paid_amount: E,
        });
        expect(await marketRemaining()).toBe(C2 - T - E);
        expect(await marketExtraCostHistory()).toBe(1);
      });
    }, 120_000);

    it('⭐ `kind = sale` filtri: E qatorlari id va jismoniy tartibda BIRINCHI bo`lsa ham rollback va `getSettlementByOrderId` sotuv qatoriga tayanadi', async () => {
      const after = await run({ approvalRequired: true }, async () => {
        expectDeferred(await sell('7001', C, E));
        await approve();
        // Sotuv va zanjir qatorlari qayta yoziladi (yangi id, jadval oxiri):
        // endi market qatori (BRANCH_SETTLED) ham id, ham jismoniy tartibda
        // birinchi.
        const repo = orderDb.getRepository(OrderSettlement);
        const moved = await repo.find({
          where: { order_id: '7001', kind: In(['sale', 'extra_cost_chain']) },
          order: { id: 'ASC' },
        });
        expect(moved).toHaveLength(2);
        await repo.delete(moved.map((row) => row.id));
        for (const row of moved) {
          const copy: Row = { ...row };
          delete copy.id;
          await repo.save(repo.create(copy as Partial<OrderSettlement>));
        }
        // Filtrsiz o'qish market qatorini olardi («HQ'ga yetgan» → 400).
        const unfiltered = await repo.findOne({
          where: { order_id: '7001', isDeleted: false },
        });
        expect(unfiltered?.kind).toBe('extra_cost_market');
        const view = (await settlement.getSettlementByOrderId('7001')) as {
          data: Row;
        };
        expect(view.data).toMatchObject({ kind: 'sale', status: 'pending' });
        expect(
          (view.data.extra_rows as Row[]).map((row) => row.kind).sort(),
        ).toEqual(['extra_cost_chain', 'extra_cost_market']);
        await rollback(COURIER, '7001');
      });
      expect(await approvalStatus('7001')).toEqual(['reversed']);
      expect(after.cashboxes).toEqual(zeroCashboxes);
      expect(after.settlement).toEqual({});
      expect(after.orders['7001']).toMatchObject({
        status: Order_status.WAITING,
        extra_cost: 0,
      });
    }, 120_000);

    it('⭐ §1: deploydan oldingi kutilayotgan (replay) so`rov turgan buyurtmada sotuv / bekor + E — 200 deferred, eski so`rov void (executed), ochiq so`rov bitta', async () => {
      const S = 20_000;
      for (const action of ['sell', 'cancel'] as const) {
        await run(
          {
            approvalRequired: true,
            courierCenterTariff: action === 'cancel' ? S : 0,
          },
          async () => {
            await addOrder('7001', C);
            const approvals = orderDb.getRepository(OrderExtraCostApproval);
            await approvals.save(
              approvals.create({
                order_id: '7001',
                market_id: MARKET_ID,
                requested_by_user_id: COURIER_ID,
                requested_by_role: 'courier',
                action,
                amount: 15_000,
                mode: 'replay',
                status: 'pending',
                proof_file_keys: [],
                operation_payload: { extraCost: 15_000 },
              }),
            );
            const res = (
              action === 'sell'
                ? await lifecycle.sellOrder(
                    COURIER,
                    '7001',
                    { extraCost: E },
                    'sell-7001',
                  )
                : await lifecycle.cancelOrder(
                    COURIER,
                    '7001',
                    { comment: 'Mijoz rad etdi', extraCost: E },
                    'cancel-7001',
                  )
            ) as { statusCode?: number; data: Row };
            expect(res.statusCode).toBe(200);
            expect(res.data?.extra_cost_request).toMatchObject({
              status: 'pending',
              mode: 'deferred',
              action,
              amount: E,
            });
            await settle();
            const rows: Row[] = await orderDb.query(
              `SELECT mode, status, closed_reason
               FROM "${orderSchema}".order_extra_cost_approvals
               WHERE order_id = 7001 ORDER BY id`,
            );
            expect(rows).toEqual([
              {
                mode: 'replay',
                status: 'void',
                closed_reason: EXTRA_COST_CLOSE_REASON.executed,
              },
              { mode: 'deferred', status: 'pending', closed_reason: null },
            ]);
            await expectNothingOfE('7001');
            await approve();
            expect(await approvalStatus('7001')).toEqual(['approved']);
          },
        );
      }
    }, 240_000);
  },
);
