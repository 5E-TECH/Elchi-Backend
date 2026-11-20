/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { defer, from, of } from 'rxjs';
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
import { OrderSettlementBranchMarketCarry } from './entities/order-settlement-branch-market-carry.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { REMITTED_CREDIT_ROW_MESSAGE } from './lifecycle/rollback-eligibility';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { FinanceServiceService } from '../../finance-service/src/finance-service.service';
import { Cashbox } from '../../finance-service/src/entities/cashbox.entity';
import { CashboxHistory } from '../../finance-service/src/entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../../finance-service/src/entities/financial-balance-history.entity';
import { Shift } from '../../finance-service/src/entities/shift.entity';
import { CashboxCard } from '../../finance-service/src/entities/cashbox-card.entity';
import { CashboxCardMovement } from '../../finance-service/src/entities/cashbox-card-movement.entity';

/**
 * Buyurtma rollback — ega qarorlari D1–D4 (2026-11-19), HAQIQIY Postgres.
 *
 * Zanjir to'liq: order-service sotuvi va rollbacki (haqiqiy tranzaksiya,
 * outbox), finance-service kassalari (kuryer → filial, filial → HQ,
 * HQ → market, menejer → market PR-C), settlement FIFO va (X, M) bo'g'ini.
 * Relay — outbox qatorlarini tartib bilan uzatadigan kichik sikl.
 *
 * Har qadamdan keyin pul invariantlari (`assertInvariants`):
 *  • har kassa balansi == o'z tarixi yig'indisi;
 *  • kuryer: kassa == Σ PENDING courier_amount − courier_to_branch qoldig'i;
 *  • market: kassa == Σ ochiq (market_amount − filial to'lagan) +
 *    hq_to_market qoldig'i (manfiy — market qarzi);
 *  • filial: kassa == Σ COURIER_SETTLED (branch_amount − filial to'lagan) −
 *    branch_to_hq qoldig'i (musbat — HQ'ga oldindan berilgan) + kuryer
 *    qoldig'i (kuryer filialga oldindan bergan naqd);
 *  • kompaniya: MAIN + filial + kuryer − market − Σ PENDING kuryer qarzi
 *    hamma qadamda bir xil «foyda» (tarif farqi) ga teng.
 * S1–S12 — orkestr ro'yxati (aktor, holat, kerakli natija).
 */
const uri = process.env.ORDER_ROLLBACK_RULES_PG_TEST_URI;
const describePg = uri ? describe : describe.skip;

type Row = Record<string, any>;

const HQ = '1';
const BRANCH = '15';
const OTHER_BRANCH = '16';
const MARKET_ID = '501';
const COURIER_ID = '301';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: BRANCH };
const MANAGER = { id: '208', roles: ['manager'], branch_id: BRANCH };
const OTHER_MANAGER = {
  id: '209',
  roles: ['manager'],
  branch_id: OTHER_BRANCH,
};
const NO_PERMISSION_MANAGER = {
  id: '210',
  roles: ['manager'],
  branch_id: BRANCH,
};
const SUPERADMIN = { id: '1', roles: ['superadmin'], branch_id: null };
const MARKET_TARIFF = 45000;
const COURIER_TARIFF = 30000;
const PRICE = 250000;
/** Har sotuv: market 205 000, kuryer 220 000 (filial sotuvida — filial). */
const MARKET_SHARE = PRICE - MARKET_TARIFF;
const COURIER_SHARE = PRICE - COURIER_TARIFF;

describePg('Rollback D1–D4 — haqiqiy Postgres (pg)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const orderSchema = `spec_rb_order_${suffix}`;
  const financeSchema = `spec_rb_fin_${suffix}`;
  let admin: DataSource;
  let orderDb: DataSource;
  let financeDb: DataSource;
  let lifecycle: OrderLifecycleService & Row;
  let settlement: OrderSettlementService;
  let finance: FinanceServiceService;
  const financeAdvances: Row[] = [];
  const courierBranch = new Map<string, string>();
  const canSellCancel = new Map<string, boolean>();

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
        OrderSettlementBranchMarketCarry,
        OrderExtraCostApproval,
        OutboxEvent,
        IdempotencyKey,
      ],
      synchronize: true,
      extra: { max: 20 },
    });
    await orderDb.initialize();

    financeDb = new DataSource({
      type: 'postgres',
      url: uri,
      schema: financeSchema,
      entities: [
        Cashbox,
        CashboxHistory,
        FinancialBalanceHistory,
        OutboxEvent,
        Shift,
        CashboxCard,
        CashboxCardMovement,
      ],
      synchronize: true,
      extra: { max: 20 },
    });
    await financeDb.initialize();

    const lookup = {
      getHqBranchId: jest.fn().mockResolvedValue(HQ),
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
      getUserById: jest.fn((id: string) =>
        Promise.resolve({
          id,
          tariff_center: 0,
          tariff_home: 0,
          can_add_extra_cost: true,
          can_sell_cancel: canSellCancel.get(String(id)) ?? true,
        }),
      ),
      getUserByIdStrict: jest.fn((id: string) =>
        Promise.resolve({
          id,
          can_add_extra_cost: true,
          can_sell_cancel: canSellCancel.get(String(id)) ?? true,
        }),
      ),
      // WX-5 — rollback kassani qat'iy o'qiydi; mock oddiy o'qishga yo'naltiriladi.
      getCashboxByUserStrict(
        this: { getCashboxByUser: (...a: unknown[]) => unknown },
        ...args: unknown[]
      ) {
        return this.getCashboxByUser(...args);
      },
      getCashboxByUser: jest.fn(async (userId: string, type: Cashbox_type) =>
        financeDb.getRepository(Cashbox).findOne({
          where: { user_id: String(userId), cashbox_type: type },
        }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      // OrderLookupService.resolveSettlementBranchId bilan AYNAN.
      resolveSettlementBranchId: jest.fn((order: Row) => {
        const branchId = String(
          order?.holder_branch_id ?? order?.branch_id ?? '',
        ).trim();
        return Promise.resolve(branchId && branchId !== HQ ? branchId : null);
      }),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getBranchAssignmentByUser: jest.fn((id: string) =>
        Promise.resolve({ branch_id: courierBranch.get(String(id)) ?? BRANCH }),
      ),
      getBranchAssignmentByUserStrict: jest.fn((id: string) =>
        Promise.resolve({ branch_id: courierBranch.get(String(id)) ?? BRANCH }),
      ),
      getBranchIdsByUserIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          new Map(ids.map((id) => [id, courierBranch.get(id) ?? BRANCH])),
        ),
      ),
    };

    settlement = new OrderSettlementService(
      orderDb,
      orderDb.getRepository(OrderSettlement),
      {} as never,
      lookup as never,
    );

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
        // PR-C: menejer → market to'lovi ulushni order-service'dan o'qiydi.
        send: jest.fn((pattern: { cmd?: string }, payload: Row) => {
          if (pattern?.cmd === 'order.settlement.branch_market_share') {
            return defer(() =>
              from(settlement.getBranchMarketShare(payload as never)),
            );
          }
          return of({ statusCode: 200, data: {} });
        }),
      } as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({})) } as never,
      new OutboxService(financeDb.getRepository(OutboxEvent)),
    );
    jest
      .spyOn(finance as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(finance as never, 'tryPublishAdvanceNow')
      .mockResolvedValue(undefined as never);

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
      // Pochta 9001 — X kuryeri; 9002 — filial o'tkazma pochtasi (kuryersiz,
      // menejer sotuvi).
      logisticsClient: {
        send: jest.fn((_pattern: unknown, payload: Row) =>
          of({
            data: {
              id: String(payload?.id ?? '9001'),
              courier_id: String(payload?.id) === '9002' ? null : COURIER_ID,
            },
          }),
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
      shouldDeferExtraCost: jest.fn().mockReturnValue(false),
      mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    });
    lifecycle = instance;
  }, 60_000);

  afterAll(async () => {
    if (orderDb?.isInitialized) await orderDb.destroy();
    if (financeDb?.isInitialized) await financeDb.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${orderSchema}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${financeSchema}" CASCADE`);
      // `branch_schema` umumiy (boshqa spec'lar ham) — tushirilmaydi.
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

  beforeEach(async () => {
    financeAdvances.length = 0;
    courierBranch.clear();
    canSellCancel.clear();
    canSellCancel.set(NO_PERMISSION_MANAGER.id, false);
    await orderDb.query(
      `TRUNCATE "${orderSchema}".orders, "${orderSchema}".order_settlement,
        "${orderSchema}".order_settlement_carry,
        "${orderSchema}".order_settlement_branch_market_carry,
        "${orderSchema}".order_extra_cost_approvals,
        "${orderSchema}".outbox_events,
        "${orderSchema}".idempotency_keys RESTART IDENTITY CASCADE`,
    );
    await financeDb.query(
      `TRUNCATE "${financeSchema}".cashbox_history,
        "${financeSchema}".financial_balance_history,
        "${financeSchema}".outbox_events,
        "${financeSchema}".cashboxes RESTART IDENTITY CASCADE`,
    );
    await seedCashbox('0', Cashbox_type.MAIN);
    await seedCashbox(MARKET_ID, Cashbox_type.FOR_MARKET);
    await seedCashbox(COURIER_ID, Cashbox_type.FOR_COURIER);
    await seedCashbox(BRANCH, Cashbox_type.BRANCH);
  });

  /** Kuryer qo'lidagi, filial X ga tegishli buyurtma. */
  const addOrder = (
    id: string,
    over: Partial<Record<string, unknown>> = {},
  ) => {
    const row = {
      id,
      market_id: MARKET_ID,
      customer_id: 801,
      status: 'waiting',
      source: 'internal',
      total_price: PRICE,
      where_deliver: 'center',
      holder_type: 'COURIER',
      holder_courier_id: COURIER_ID,
      holder_branch_id: BRANCH,
      courier_id: COURIER_ID,
      post_id: 9001,
      branch_id: BRANCH,
      home_branch_id: BRANCH,
      ...over,
    };
    const keys = Object.keys(row);
    return orderDb.query(
      `INSERT INTO "${orderSchema}".orders (${keys.map((k) => `"${k}"`).join(', ')})
       VALUES (${keys.map((_k, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => (row as Row)[k]),
    );
  };

  /** order outbox → finance (kassa); finance outbox → order (FIFO). */
  const relay = async () => {
    for (let round = 0; round < 5; round += 1) {
      let moved = 0;
      const orderRows: Array<{ id: string; pattern: string; payload: Row }> =
        await orderDb.query(
          `SELECT id, pattern, payload FROM "${orderSchema}".outbox_events
           WHERE status = 'pending' ORDER BY id`,
        );
      for (const row of orderRows) {
        if (row.pattern === 'finance.cashbox.update_balance') {
          await finance.updateBalance(row.payload as never);
        }
        await orderDb.query(
          `UPDATE "${orderSchema}".outbox_events SET status = 'published' WHERE id = $1`,
          [row.id],
        );
        moved += 1;
      }
      const financeRows: Array<{ id: string; pattern: string; payload: Row }> =
        await financeDb.query(
          `SELECT id, pattern, payload FROM "${financeSchema}".outbox_events
           WHERE status = 'pending' ORDER BY id`,
        );
      for (const row of financeRows) {
        if (row.pattern === 'order.settlement.advance') {
          await settlement.advanceSettlement(row.payload as never);
        }
        await financeDb.query(
          `UPDATE "${financeSchema}".outbox_events SET status = 'published' WHERE id = $1`,
          [row.id],
        );
        moved += 1;
      }
      if (!moved) return;
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

  const carry = async (level: string, party: string) =>
    Number(
      (
        await orderDb.query(
          `SELECT COALESCE(SUM(amount), 0)::float8 AS s
             FROM "${orderSchema}".order_settlement_carry
            WHERE level = $1 AND party_id = $2`,
          [level, party],
        )
      )[0].s,
    );

  const saleRow = async (id: string) =>
    (
      await orderDb.query(
        `SELECT status::text AS status, courier_amount::float8 AS courier,
                branch_amount::float8 AS branch, market_amount::float8 AS market,
                market_paid_by_branch_amount::float8 AS paid_by_branch
           FROM "${orderSchema}".order_settlement
          WHERE order_id = $1 AND is_deleted = false AND kind = 'sale'`,
        [id],
      )
    )[0] as Row | undefined;

  const orderStatus = async (id: string) =>
    (
      await orderDb.query(
        `SELECT status FROM "${orderSchema}".orders WHERE id = $1`,
        [id],
      )
    )[0]?.status as string;

  /** Kompaniya holati (pulning saqlanishi): har qadamda doimiy bo'lishi kerak. */
  const snapshot = async () => ({
    main: await balance('0', Cashbox_type.MAIN),
    branch: await balance(BRANCH, Cashbox_type.BRANCH),
    courier: await balance(COURIER_ID, Cashbox_type.FOR_COURIER),
    market: await balance(MARKET_ID, Cashbox_type.FOR_MARKET),
    carries: {
      courier: await carry('courier_to_branch', COURIER_ID),
      branch: await carry('branch_to_hq', BRANCH),
      market: await carry('hq_to_market', MARKET_ID),
    },
  });

  const sumOf = async (sql: string, params: unknown[] = []) =>
    Number(
      (
        await orderDb.query(`SELECT COALESCE((${sql}), 0)::float8 AS s`, params)
      )[0].s,
    );

  const assertInvariants = async () => {
    // I1 — kassa == o'z tarixi.
    const drift: Row[] = await financeDb.query(
      `SELECT cb.user_id, cb.cashbox_type, cb.balance::float8 AS balance,
              COALESCE(SUM(CASE WHEN h.operation_type = 'income' THEN h.amount
                                ELSE -h.amount END), 0)::float8 AS history
         FROM "${financeSchema}".cashboxes cb
         LEFT JOIN "${financeSchema}".cashbox_history h ON h.cashbox_id = cb.id
        GROUP BY cb.id`,
    );
    for (const row of drift) {
      expect({ who: row.user_id, diff: row.balance - row.history }).toEqual({
        who: row.user_id,
        diff: 0,
      });
    }
    const s = await snapshot();
    // Kuryer.
    const courierOwed = await sumOf(
      `SELECT SUM(courier_amount) FROM "${orderSchema}".order_settlement
        WHERE is_deleted = false AND status = 'pending' AND courier_id = $1`,
      [COURIER_ID],
    );
    expect(s.courier).toBeCloseTo(courierOwed - s.carries.courier, 2);
    // Market.
    const marketOpen = await sumOf(
      `SELECT SUM(market_amount - market_paid_by_branch_amount)
         FROM "${orderSchema}".order_settlement
        WHERE is_deleted = false AND status <> 'market_settled' AND market_id = $1`,
      [MARKET_ID],
    );
    // B-1 — musbat `hq_to_market` qoldig'i: HQ marketga OLDINDAN bergan
    // (market oldindan olgan); (X, M) — filial marketga oldindan bergani.
    const branchMarketCarry = await sumOf(
      `SELECT SUM(amount) FROM "${orderSchema}".order_settlement_branch_market_carry
        WHERE market_id = $1`,
      [MARKET_ID],
    );
    expect(s.market).toBeCloseTo(
      marketOpen - s.carries.market - branchMarketCarry,
      2,
    );
    // Filial.
    const branchOwed = await sumOf(
      `SELECT SUM(branch_amount - market_paid_by_branch_amount)
         FROM "${orderSchema}".order_settlement
        WHERE is_deleted = false AND status = 'courier_settled' AND branch_id = $1`,
      [BRANCH],
    );
    // Kuryer qoldig'i (kredit) — kuryer filialga OLDINDAN bergan naqd: u
    // filial kassasida turibdi, kuryerning keyingi topshirig'idan ayiriladi.
    // RX-6 — (X, M) qoldig'i: filial marketga OLDINDAN bergan naqd.
    const branchMarketPrepaid = await sumOf(
      `SELECT SUM(amount) FROM "${orderSchema}".order_settlement_branch_market_carry
        WHERE branch_id = $1`,
      [BRANCH],
    );
    expect(s.branch).toBeCloseTo(
      branchOwed - s.carries.branch + s.carries.courier - branchMarketPrepaid,
      2,
    );
    return s;
  };

  // ── Amallar ───────────────────────────────────────────────────────────────
  const sell = async (
    actor: Row,
    id: string,
    dto: Row = {},
    key = `sell-${id}`,
  ) => {
    await lifecycle.sellOrder(actor as never, id, dto, key);
    await relay();
    await assertInvariants();
  };
  const cancel = async (actor: Row, id: string, dto: Row = {}) => {
    await lifecycle.cancelOrder(
      actor as never,
      id,
      { comment: 'test', ...dto },
      `cancel-${id}`,
    );
    await relay();
  };
  const courierPays = async (amount: number, key: string) => {
    await finance.paymentsFromCourier({
      courier_id: COURIER_ID,
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: MANAGER.id,
      receiver_user_id: BRANCH,
      receiver_cashbox_type: Cashbox_type.BRANCH,
      dedup_epoch: key,
    });
    await relay();
    await assertInvariants();
  };
  const branchPaysHq = async (amount: number, key: string) => {
    await finance.paymentFromBranchToMain({
      branch_id: BRANCH,
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: MANAGER.id,
      dedup_epoch: key,
    });
    await relay();
    await assertInvariants();
  };
  const hqPaysMarket = async (amount: number, key: string) => {
    await finance.paymentsToMarket({
      market_id: MARKET_ID,
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: SUPERADMIN.id,
      dedup_epoch: key,
    });
    await relay();
    await assertInvariants();
  };
  const managerPaysMarket = async (amount: number, key: string) => {
    await finance.paymentsToMarket({
      market_id: MARKET_ID,
      amount,
      payment_method: PaymentMethod.CASH,
      payer_cashbox_type: Cashbox_type.BRANCH,
      payer_user_id: BRANCH,
      created_by: MANAGER.id,
      dedup_epoch: key,
    });
    await relay();
    await assertInvariants();
  };
  const rollback = async (
    actor: Row,
    id: string,
    key: string,
    target?: 'waiting' | 'cancelled',
  ) => {
    const res = await lifecycle.rollbackOrderToWaiting(
      actor as never,
      id,
      target ? { target_status: target } : undefined,
      key,
    );
    await relay();
    await assertInvariants();
    return res as { statusCode: number; message: string };
  };
  const rejection = async (actor: Row, id: string, key: string) => {
    const error = await lifecycle
      .rollbackOrderToWaiting(actor as never, id, undefined, key)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).not.toBeNull();
    return (error as { getError: () => Row }).getError();
  };
  /** Ro'yxat maydoni (`rollback`) — endpoint bilan AYNI qaror. */
  const listDecision = async (actor: Row, id: string) => {
    const res: Row = await lifecycle.rollbackEligibilityForIds(
      [id],
      actor as never,
    );
    return res.data.items[0] as Row;
  };

  /** Kompaniya «foydasi»: MAIN + filial + kuryer qo'lidagi − marketga qarz. */
  const equity = async () => {
    const s = await snapshot();
    return Math.round((s.main + s.branch + s.courier - s.market) * 100) / 100;
  };

  /** Ruxsat berilgan rollback: ro'yxat maydoni ham `allowed: true`. */
  const allowedRollback = async (
    actor: Row,
    id: string,
    key: string,
    target?: 'waiting' | 'cancelled',
  ) => {
    expect(await listDecision(actor, id)).toEqual({
      order_id: id,
      allowed: true,
      code: null,
      message: null,
    });
    return rollback(actor, id, key, target);
  };
  /** Rad etilgan rollback: endpoint kodi == ro'yxat kodi, hech narsa o'zgarmaydi. */
  const deniedRollback = async (
    actor: Row,
    id: string,
    code: string,
    status = 400,
  ) => {
    const before = { snap: await snapshot(), row: await saleRow(id) };
    const list = await listDecision(actor, id);
    const error = await rejection(actor, id, `rb-denied-${id}-${actor.id}`);
    expect(error).toMatchObject({ statusCode: status, code });
    expect(list).toMatchObject({
      allowed: false,
      code,
      message: error.message,
    });
    await relay();
    expect({ snap: await snapshot(), row: await saleRow(id) }).toEqual(before);
    return error;
  };

  describe('S1–S12 (orkestr ro`yxati)', () => {
    it('S1: kuryer sotdi, pul kuryerda — menejer qaytaradi; kassalar 0', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await allowedRollback(MANAGER, '7001', 'rb-s1');
      expect(await orderStatus('7001')).toBe(Order_status.WAITING);
      expect(await snapshot()).toEqual({
        main: 0,
        branch: 0,
        courier: 0,
        market: 0,
        carries: { courier: 0, branch: 0, market: 0 },
      });
    }, 60_000);

    it.each([
      ['menejer (D1)', MANAGER],
      ['superadmin (M6)', SUPERADMIN],
    ])(
      '⭐ S2: kuryer filialga topshirdi (COURIER_SETTLED) — %s qaytaradi, kuryerga kredit, naqd filialda qoladi',
      async (_label, actor) => {
        await addOrder('7001');
        await sell(COURIER, '7001');
        await courierPays(COURIER_SHARE, 'cp-s2');
        expect((await saleRow('7001'))?.status).toBe(
          SettlementStatus.COURIER_SETTLED,
        );
        await deniedRollback(COURIER, '7001', 'COURIER_REMITTED');

        const res = await allowedRollback(actor, '7001', 'rb-s2');
        expect(res.message).toContain(
          `Kuryer filialga topshirgan ${COURIER_SHARE} so'm uning keyingi topshirig'iga hisoblanadi`,
        );
        expect(await snapshot()).toEqual({
          main: 0,
          branch: COURIER_SHARE,
          courier: -COURIER_SHARE,
          market: 0,
          carries: { courier: COURIER_SHARE, branch: 0, market: 0 },
        });
        expect(await equity()).toBe(0);

        // Qayta sotuv: kuryer yangi topshirig'ida kreditni ishlatadi.
        await sell(COURIER, '7001', {}, 'resell-s2');
        expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(0);
        expect(await equity()).toBe(PRICE - MARKET_SHARE - COURIER_TARIFF);
      },
      60_000,
    );

    it('S3: menejer sotdi, posilka filialda — menejer qaytaradi', async () => {
      await addOrder('7001', {
        holder_type: 'BRANCH',
        holder_courier_id: null,
        courier_id: null,
        post_id: 9002,
      });
      await sell(MANAGER, '7001');
      await allowedRollback(MANAGER, '7001', 'rb-s3');
      expect(await orderStatus('7001')).toBe(Order_status.WAITING);
      expect(await equity()).toBe(0);
    }, 60_000);

    it('⭐ S4: menejer sotdi, filial HQ`ga to`ladi (BRANCH_SETTLED) — menejer 400 SUPERADMIN_ONLY, superadmin to`liq teskari', async () => {
      await addOrder('7001', {
        holder_type: 'BRANCH',
        holder_courier_id: null,
        courier_id: null,
        post_id: 9002,
      });
      await sell(MANAGER, '7001');
      const row = await saleRow('7001');
      const branchCash = await balance(BRANCH, Cashbox_type.BRANCH);
      await branchPaysHq(branchCash, 'bp-s4');
      expect((await saleRow('7001'))?.status).toBe(
        SettlementStatus.BRANCH_SETTLED,
      );
      await deniedRollback(MANAGER, '7001', 'SUPERADMIN_ONLY');

      const mainBefore = await balance('0', Cashbox_type.MAIN);
      await allowedRollback(SUPERADMIN, '7001', 'rb-s4');
      // Naqd ko'chmaydi: HQ'dagi pul joyida, filialga kredit (branch_amount).
      expect(await balance('0', Cashbox_type.MAIN)).toBe(mainBefore);
      expect(await carry('branch_to_hq', BRANCH)).toBe(row?.branch);
      expect(await carry('hq_to_market', MARKET_ID)).toBe(0);
      expect(await equity()).toBe(0);
    }, 60_000);

    it('S5: kuryer bekor qildi, posilka kuryerda — menejer qaytaradi (D4: o`z kuryeri)', async () => {
      await addOrder('7001');
      await cancel(COURIER, '7001');
      expect(await orderStatus('7001')).toBe(Order_status.CANCELLED);
      await allowedRollback(MANAGER, '7001', 'rb-s5');
      expect(await orderStatus('7001')).toBe(Order_status.WAITING);
    }, 60_000);

    it('S7: boshqa filial menejeri — 400 NOT_OWN_BRANCH', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await deniedRollback(OTHER_MANAGER, '7001', 'NOT_OWN_BRANCH');
    }, 60_000);

    it('S8: kuryer sotdi — menejer `cancelled` ga qaytaradi', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await allowedRollback(MANAGER, '7001', 'rb-s8', 'cancelled');
      expect(await orderStatus('7001')).toBe(Order_status.CANCELLED);
      expect(await equity()).toBe(0);
    }, 60_000);

    it('⭐ S9: ikki sotuv, kuryer 220 000 topshirdi (A COURIER_SETTLED, B PENDING) — menejer ikkalasini qaytaradi', async () => {
      await addOrder('7001');
      await addOrder('7002');
      await sell(COURIER, '7001');
      await sell(COURIER, '7002');
      await courierPays(COURIER_SHARE, 'cp-s9');
      expect((await saleRow('7001'))?.status).toBe(
        SettlementStatus.COURIER_SETTLED,
      );
      expect((await saleRow('7002'))?.status).toBe(SettlementStatus.PENDING);

      await allowedRollback(MANAGER, '7001', 'rb-s9-a');
      expect(await carry('courier_to_branch', COURIER_ID)).toBe(COURIER_SHARE);
      await allowedRollback(MANAGER, '7002', 'rb-s9-b');
      expect(await snapshot()).toEqual({
        main: 0,
        branch: COURIER_SHARE,
        courier: -COURIER_SHARE,
        market: 0,
        carries: { courier: COURIER_SHARE, branch: 0, market: 0 },
      });
      expect(await equity()).toBe(0);
    }, 60_000);

    it('S10: kuryer bekor qildi, posilkani filialga topshirdi — menejer qaytaradi', async () => {
      await addOrder('7001');
      await cancel(COURIER, '7001');
      await orderDb.query(
        `UPDATE "${orderSchema}".orders SET holder_type = 'BRANCH',
           holder_courier_id = NULL, holder_branch_id = $1 WHERE id = '7001'`,
        [BRANCH],
      );
      await allowedRollback(MANAGER, '7001', 'rb-s10');
    }, 60_000);

    it.each([
      ['DB holati `cancelled (sent)`', Order_status.CANCELLED_SENT],
      ['holati `cancelled`, lekin bekorlar pochtasida', Order_status.CANCELLED],
    ])(
      '⭐ S11: %s — menejer va kuryer 400 PARCEL_NOT_IN_BRANCH',
      async (_label, status) => {
        await addOrder('7001');
        await cancel(COURIER, '7001');
        await orderDb.query(
          `UPDATE "${orderSchema}".orders SET status = $1, canceled_post_id = 9100
            WHERE id = '7001'`,
          [status],
        );
        await deniedRollback(MANAGER, '7001', 'PARCEL_NOT_IN_BRANCH');
        await deniedRollback(COURIER, '7001', 'PARCEL_NOT_IN_BRANCH');
      },
      60_000,
    );

    it('⭐ S12: bekor posilka HQ`da (holder HQ, branch_id hali X) — menejer 400 PARCEL_NOT_IN_BRANCH, superadmin qaytaradi', async () => {
      await addOrder('7001');
      await cancel(COURIER, '7001');
      await orderDb.query(
        `UPDATE "${orderSchema}".orders SET holder_type = 'HQ',
           holder_courier_id = NULL, holder_branch_id = NULL, branch_id = $1
          WHERE id = '7001'`,
        [BRANCH],
      );
      await deniedRollback(MANAGER, '7001', 'PARCEL_NOT_IN_BRANCH');
      await allowedRollback(SUPERADMIN, '7001', 'rb-s12');
      expect(await orderStatus('7001')).toBe(Order_status.WAITING);
    }, 60_000);
  });

  it('S6: kuryer 10 000 xarajat bilan bekor qildi, keyin boshqa sotuv; kuryer hammasini topshirdi — manfiy (kredit) qator: menejer SUPERADMIN_ONLY, superadmin CORRECTION_REQUIRED (S1 javobi)', async () => {
    await addOrder('7001');
    await addOrder('7002');
    await cancel(COURIER, '7001', { extraCost: 10000 });
    await relay();
    await sell(COURIER, '7002');
    const due = await balance(COURIER_ID, Cashbox_type.FOR_COURIER);
    await courierPays(due, 'cp-s6');
    expect(await saleRow('7001')).toMatchObject({
      status: SettlementStatus.COURIER_SETTLED,
      courier: -10000,
    });
    // S1 javobi: M6 rad sabablari menejerga ham — manfiy (kredit) qator
    // (kuryer xarajat kreditini topshiriqda ishlatgan) qoldiqni manfiy
    // qilardi. Menejer — SUPERADMIN_ONLY, superadmin — CORRECTION_REQUIRED.
    const managerError = await deniedRollback(
      MANAGER,
      '7001',
      'SUPERADMIN_ONLY',
    );
    // Xabar yo'l ko'rsatadi (orkestr talabi): T6 — to'lovni qaytarish / tahrirlash.
    expect(managerError.message).toBe(REMITTED_CREDIT_ROW_MESSAGE);
    const saError = await deniedRollback(
      SUPERADMIN,
      '7001',
      'CORRECTION_REQUIRED',
    );
    expect(saError.message).toBe(REMITTED_CREDIT_ROW_MESSAGE);
  }, 60_000);

  describe('D2 — superadmin: HQ`ga o`tgan, market to`langan, filial marketga to`lagan', () => {
    it('⭐ MARKET_SETTLED (HQ marketga to`lagan): kuryer + filial kredit, market oldindan olgan (hq_to_market +=); HQ neti 0; menejer to`lovi chegarasi 0', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await courierPays(COURIER_SHARE, 'cp-ms');
      await branchPaysHq(COURIER_SHARE, 'bp-ms');
      await hqPaysMarket(MARKET_SHARE, 'mp-ms');
      expect((await saleRow('7001'))?.status).toBe(
        SettlementStatus.MARKET_SETTLED,
      );
      for (const actor of [COURIER, MANAGER]) {
        await deniedRollback(actor, '7001', 'SUPERADMIN_ONLY');
      }

      const cashBefore = {
        main: await balance('0', Cashbox_type.MAIN),
        branch: await balance(BRANCH, Cashbox_type.BRANCH),
      };
      const res = await allowedRollback(SUPERADMIN, '7001', 'rb-ms');
      expect(res.message).toContain(`Filialga ${COURIER_SHARE} so'm`);
      expect(res.message).toContain(`Market ${MARKET_SHARE} so'm`);
      // Naqd ko'chmaydi (HQ va filial kassasi joyida).
      expect(await balance('0', Cashbox_type.MAIN)).toBe(cashBefore.main);
      expect(await balance(BRANCH, Cashbox_type.BRANCH)).toBe(
        cashBefore.branch,
      );
      expect(await snapshot()).toEqual({
        main: COURIER_SHARE - MARKET_SHARE,
        branch: 0,
        courier: -COURIER_SHARE,
        market: -MARKET_SHARE,
        carries: {
          courier: COURIER_SHARE,
          branch: COURIER_SHARE,
          market: MARKET_SHARE,
        },
      });
      // HQ neti: oldin +220 000 (filialdan) − 205 000 (marketga) = 15 000;
      // kelajakda −220 000 (filial krediti) + 205 000 (market oldindan olgan) → 0.
      const s = await snapshot();
      expect(s.main - s.carries.branch + s.carries.market).toBe(0);
      expect(await equity()).toBe(0);

      // S3 (orkestr): market qarzdor — menejer to'lovi chegarasi 0.
      await addOrder('7002');
      await sell(COURIER, '7002');
      // Kuryer krediti (220 000) yangi sotuvni to'liq qoplaydi — sof-nol yopish.
      expect(await balance(COURIER_ID, Cashbox_type.FOR_COURIER)).toBe(0);
      await settlement.closeZeroCourierRows({
        courier_id: COURIER_ID,
        requester: { id: MANAGER.id, roles: MANAGER.roles },
      });
      await relay();
      await assertInvariants();
      // Kaskad: filial krediti (220 000) ham darhol qo'llandi — HQ'ga
      // qayta pul berilmaydi (rollback'dan oldin bergani hisoblandi); B-1 —
      // market oldindan olgan 205 000 ham qo'llanadi: HQ marketga qayta
      // to'lamaydi, qator MARKET_SETTLED.
      expect((await saleRow('7002'))?.status).toBe(
        SettlementStatus.MARKET_SETTLED,
      );
      expect(await carry('branch_to_hq', BRANCH)).toBe(0);
      expect(await carry('courier_to_branch', COURIER_ID)).toBe(0);
      expect(await carry('hq_to_market', MARKET_ID)).toBe(0);
      // Market kassasi: −205 000 + 205 000 = 0 → payable = min(ulush, 0) = 0.
      expect(await balance(MARKET_ID, Cashbox_type.FOR_MARKET)).toBe(0);
      await expect(managerPaysMarket(1, 'mm-ms-2')).rejects.toMatchObject({
        error: {
          statusCode: 400,
          message:
            "Summa to'lash mumkin bo'lgan summadan oshib ketdi (To'lash mumkin: 0 so'm)",
        },
      });
    }, 60_000);

    it('⭐ PR-C: kuryer topshirgan, filial marketga qisman P = 100 000 to`lagan (COURIER_SETTLED) — filial krediti P, market debeti P, kuryerga kredit', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await courierPays(COURIER_SHARE, 'cp-prc');
      await managerPaysMarket(100000, 'mm-prc');
      expect(await saleRow('7001')).toMatchObject({
        status: SettlementStatus.COURIER_SETTLED,
        paid_by_branch: 100000,
      });
      await deniedRollback(MANAGER, '7001', 'SUPERADMIN_ONLY');

      await allowedRollback(SUPERADMIN, '7001', 'rb-prc');
      expect(await snapshot()).toEqual({
        main: 0,
        branch: COURIER_SHARE - 100000,
        courier: -COURIER_SHARE,
        market: -100000,
        carries: { courier: COURIER_SHARE, branch: 100000, market: 100000 },
      });
      expect(await equity()).toBe(0);
    }, 60_000);

    it('⭐ PR-C: filial marketga to`liq to`lab, qolganini HQ`ga bergan (MARKET_SETTLED) — filial krediti branch_amount, market debeti market_amount', async () => {
      await addOrder('7001');
      await sell(COURIER, '7001');
      await courierPays(COURIER_SHARE, 'cp-prc2');
      await managerPaysMarket(MARKET_SHARE, 'mm-prc2');
      await branchPaysHq(COURIER_SHARE - MARKET_SHARE, 'bp-prc2');
      expect(await saleRow('7001')).toMatchObject({
        status: SettlementStatus.MARKET_SETTLED,
        paid_by_branch: MARKET_SHARE,
      });

      await allowedRollback(SUPERADMIN, '7001', 'rb-prc2');
      expect(await snapshot()).toEqual({
        main: COURIER_SHARE - MARKET_SHARE,
        branch: 0,
        courier: -COURIER_SHARE,
        market: -MARKET_SHARE,
        carries: {
          courier: COURIER_SHARE,
          branch: COURIER_SHARE,
          market: MARKET_SHARE,
        },
      });
      expect(await equity()).toBe(0);
      // (X, M) qoldig'i tegilmaydi — manfiy (X, M) semantikasi yo'q.
      const [{ n }] = await orderDb.query(
        `SELECT count(*)::int AS n FROM "${orderSchema}".order_settlement_branch_market_carry
          WHERE amount <> 0`,
      );
      expect(n).toBe(0);
    }, 60_000);
  });

  /**
   * B-2 — qaror tranzaksiyadan OLDIN; shu orada to'lov qatorni o'zgartiradi.
   * Rollback tranzaksiyasi ochilishidan oldin (`connect`) aralashuv bajariladi.
   */
  const rollbackWithInterleave = async (
    actor: Row,
    id: string,
    key: string,
    interleave: () => Promise<void>,
  ) => {
    // `DataSource.query` ham queryRunner ochadi — aralashuv faqat birinchi
    // `startTransaction` da (ya'ni rollback tranzaksiyasi, qarordan keyin).
    const ds = (lifecycle as unknown as { dataSource: DataSource }).dataSource;
    const original = ds.createQueryRunner.bind(ds);
    let fired = false;
    const spy = jest
      .spyOn(ds, 'createQueryRunner')
      .mockImplementation(
        (...args: Parameters<DataSource['createQueryRunner']>) => {
          const qr = original(...args);
          if (fired) return qr;
          const start = qr.startTransaction.bind(qr);
          qr.startTransaction = async (...startArgs) => {
            if (!fired) {
              fired = true;
              await interleave();
            }
            return start(...startArgs);
          };
          return qr;
        },
      );
    try {
      return await lifecycle
        .rollbackOrderToWaiting(actor as never, id, undefined, key)
        .then(
          () => null,
          (e: unknown) => (e as { getError: () => Row }).getError(),
        );
    } finally {
      spy.mockRestore();
      expect(fired).toBe(true);
    }
  };

  describe('B-2 — oddiy yo`l: qulf ostida qayta tekshiruv (STATE_CHANGED)', () => {
    it.each([1, 2, 3])(
      '⭐ RX-1 #%i: to`lov qarordan KEYIN, pochta so`rovi oynasida commit bo`ladi (hook`siz) — 400 STATE_CHANGED, kreditsiz o`chirish yo`q',
      async (round) => {
        await addOrder('7001');
        await sell(COURIER, '7001');
        expect((await saleRow('7001'))?.status).toBe(SettlementStatus.PENDING);
        // Menejer: qaror pochtasiz; endpointning pochta so'rovi (qarordan
        // keyin, tranzaksiyadan oldin) — shu oynada kuryer topshiradi.
        const send = (
          lifecycle as unknown as { logisticsClient: { send: jest.Mock } }
        ).logisticsClient.send;
        let paid = false;
        send.mockImplementationOnce((_pattern: unknown, payload: Row) =>
          defer(async () => {
            await courierPays(COURIER_SHARE, `cp-rx1-${round}`);
            paid = true;
            return {
              data: {
                id: String(payload?.id ?? '9001'),
                courier_id: COURIER_ID,
              },
            };
          }),
        );
        const error = await rejection(MANAGER, '7001', `rb-rx1-${round}`);
        expect(paid).toBe(true);
        expect(error).toMatchObject({ statusCode: 400, code: 'STATE_CHANGED' });
        await relay();
        await assertInvariants();
        expect(await orderStatus('7001')).toBe(Order_status.SOLD);
        expect((await saleRow('7001'))?.status).toBe(
          SettlementStatus.COURIER_SETTLED,
        );
        // Qayta urinish — D1 (kuryerga kredit).
        await allowedRollback(MANAGER, '7001', `rb-rx1-retry-${round}`);
        expect(await carry('courier_to_branch', COURIER_ID)).toBe(
          COURIER_SHARE,
        );
        expect(await equity()).toBe(0);
      },
      60_000,
    );

    it.each([1, 2, 3])(
      '⭐ #%i (a) kuryer sotdi (PENDING); qaror va tranzaksiya orasida kuryer topshirdi (COURIER_SETTLED) — 400 STATE_CHANGED, daftar mos',
      async (round) => {
        await addOrder('7001');
        await sell(COURIER, '7001');
        expect((await saleRow('7001'))?.status).toBe(SettlementStatus.PENDING);
        const error = await rollbackWithInterleave(
          MANAGER,
          '7001',
          `rb-b2a-${round}`,
          () => courierPays(COURIER_SHARE, `cp-b2a-${round}`),
        );
        expect(error).toMatchObject({ statusCode: 400, code: 'STATE_CHANGED' });
        await relay();
        await assertInvariants();
        expect(await orderStatus('7001')).toBe(Order_status.SOLD);
        expect((await saleRow('7001'))?.status).toBe(
          SettlementStatus.COURIER_SETTLED,
        );
        // Qayta urinish — yangi qaror (D1: kuryerga kredit) bilan o'tadi.
        await allowedRollback(MANAGER, '7001', `rb-b2a-retry-${round}`);
        expect(await carry('courier_to_branch', COURIER_ID)).toBe(
          COURIER_SHARE,
        );
        expect(await equity()).toBe(0);
      },
      60_000,
    );

    it.each([1, 2, 3])(
      '⭐ #%i (b) menejer sotdi (naqd filialda); orada filial HQ`ga to`ladi (BRANCH_SETTLED) — 400 STATE_CHANGED, daftar mos',
      async (round) => {
        await addOrder('7001', {
          holder_type: 'BRANCH',
          holder_courier_id: null,
          courier_id: null,
          post_id: 9002,
        });
        await sell(MANAGER, '7001');
        const before = await saleRow('7001');
        const amount = Number(
          (
            await orderDb.query(
              `SELECT branch_amount::float8 AS a FROM "${orderSchema}".order_settlement
                WHERE order_id = '7001' AND kind = 'sale' AND is_deleted = false`,
            )
          )[0].a,
        );
        const error = await rollbackWithInterleave(
          MANAGER,
          '7001',
          `rb-b2b-${round}`,
          () => branchPaysHq(amount, `bp-b2b-${round}`),
        );
        expect(error).toMatchObject({ statusCode: 400, code: 'STATE_CHANGED' });
        await relay();
        await assertInvariants();
        expect(await orderStatus('7001')).toBe(Order_status.SOLD);
        expect((await saleRow('7001'))?.status).toBe(
          SettlementStatus.BRANCH_SETTLED,
        );
        // Menejer sotuvi — naqd filialda (COURIER_SETTLED, kuryersiz).
        expect(before?.status).toBe(SettlementStatus.COURIER_SETTLED);
        // Endi menejerga — SUPERADMIN_ONLY (HQ'ga o'tgan).
        await deniedRollback(MANAGER, '7001', 'SUPERADMIN_ONLY');
      },
      60_000,
    );
  });

  it('⭐ B-3: migratsiya 246 konvertatsiya izidagi qator — superadmin CORRECTION_REQUIRED, menejer SUPERADMIN_ONLY', async () => {
    await addOrder('7001');
    await sell(COURIER, '7001');
    await courierPays(COURIER_SHARE, 'cp-b3');
    await managerPaysMarket(100000, 'mm-b3');
    const [{ id: saleId }] = await orderDb.query(
      `SELECT id FROM "${orderSchema}".order_settlement
        WHERE order_id = '7001' AND kind = 'sale' AND is_deleted = false`,
    );
    await orderDb.query(
      `CREATE TABLE "${orderSchema}".order_settlement_246_conversion (
         id BIGSERIAL PRIMARY KEY, kind varchar(32) NOT NULL,
         settlement_id bigint, amount numeric(14,2) NOT NULL DEFAULT 0)`,
    );
    try {
      await orderDb.query(
        `INSERT INTO "${orderSchema}".order_settlement_246_conversion (kind, settlement_id, amount)
         VALUES ('settlement_row', $1, 100000)`,
        [saleId],
      );
      await deniedRollback(MANAGER, '7001', 'SUPERADMIN_ONLY');
      const error = await deniedRollback(
        SUPERADMIN,
        '7001',
        'CORRECTION_REQUIRED',
      );
      expect(error.message).toContain('migratsiya 246');
    } finally {
      await orderDb.query(
        `DROP TABLE "${orderSchema}".order_settlement_246_conversion`,
      );
    }
    // Izsiz — superadmin qaytaradi (D2).
    await allowedRollback(SUPERADMIN, '7001', 'rb-b3');
  }, 60_000);

  it('⭐ WX-4: menejer to`lovi (advance) yetkazilmay turib superadmin qaytaradi — to`lov (X, M) qoldig`iga tushadi; invariantlar (XM a`zosi bilan) saqlanadi', async () => {
    await addOrder('7001');
    await sell(COURIER, '7001');
    await courierPays(COURIER_SHARE, 'cp-wx4');
    // Finance to'lovi commit — order tomonga advance hali yetkazilmagan.
    await finance.paymentsToMarket({
      market_id: MARKET_ID,
      amount: 100000,
      payment_method: PaymentMethod.CASH,
      payer_cashbox_type: Cashbox_type.BRANCH,
      payer_user_id: BRANCH,
      created_by: MANAGER.id,
      dedup_epoch: 'mm-wx4',
    });
    // Rollback: relay avval rollback oyoqlarini, keyin advance'ni yetkazadi —
    // qator yo'q, to'lov (X, M) qoldig'iga.
    await allowedRollback(SUPERADMIN, '7001', 'rb-wx4');
    const [{ amount }] = await orderDb.query(
      `SELECT COALESCE(SUM(amount), 0)::float8 AS amount
         FROM "${orderSchema}".order_settlement_branch_market_carry
        WHERE branch_id = $1 AND market_id = $2`,
      [BRANCH, MARKET_ID],
    );
    expect(amount).toBe(100000);
    await assertInvariants();
    expect(await equity()).toBe(0);
    // Keyingi sotuv: (X, M) qoldig'i menejer to'lovi o'rnida qo'llanadi.
    await addOrder('7002');
    await sell(COURIER, '7002');
    await assertInvariants();
  }, 60_000);

  it('A-F6: kuryersiz bekor buyurtma, pul oyog`i yo`q — superadmin qaytaradi', async () => {
    await addOrder('7001', {
      status: 'cancelled',
      holder_type: 'BRANCH',
      holder_courier_id: null,
      courier_id: null,
      post_id: 9002,
    });
    await allowedRollback(SUPERADMIN, '7001', 'rb-af6');
    expect(await orderStatus('7001')).toBe(Order_status.WAITING);
    expect(await equity()).toBe(0);
  }, 60_000);

  it.each([1, 2, 3, 4, 5])(
    '⭐ poyga #%i: rollback ‖ kuryer to`lovi ‖ filial → HQ ‖ HQ → market ‖ menejer → market — deadlock yo`q, ikki marta yozilmaydi, invariantlar saqlanadi',
    async (round) => {
      for (const id of ['7001', '7002', '7003']) {
        await addOrder(id);
        await sell(COURIER, id);
      }
      await courierPays(COURIER_SHARE, `cp-race-${round}`);
      expect((await saleRow('7001'))?.status).toBe(
        SettlementStatus.COURIER_SETTLED,
      );

      const ops: Array<[string, () => Promise<unknown>]> = [
        [
          'rollback',
          () =>
            lifecycle.rollbackOrderToWaiting(
              round % 2 ? MANAGER : SUPERADMIN,
              '7001',
              undefined,
              `rb-race-${round}`,
            ),
        ],
        [
          'courier',
          () =>
            finance.paymentsFromCourier({
              courier_id: COURIER_ID,
              amount: COURIER_SHARE,
              payment_method: PaymentMethod.CASH,
              created_by: MANAGER.id,
              receiver_user_id: BRANCH,
              receiver_cashbox_type: Cashbox_type.BRANCH,
              dedup_epoch: `cp2-race-${round}`,
            }),
        ],
        [
          'branch_to_hq',
          () =>
            finance.paymentFromBranchToMain({
              branch_id: BRANCH,
              amount: 100000,
              payment_method: PaymentMethod.CASH,
              created_by: MANAGER.id,
              dedup_epoch: `bp-race-${round}`,
            }),
        ],
        [
          'hq_to_market',
          () =>
            finance.paymentsToMarket({
              market_id: MARKET_ID,
              amount: 50000,
              payment_method: PaymentMethod.CASH,
              created_by: SUPERADMIN.id,
              dedup_epoch: `mp-race-${round}`,
            }),
        ],
        [
          'manager_to_market',
          () =>
            finance.paymentsToMarket({
              market_id: MARKET_ID,
              amount: 50000,
              payment_method: PaymentMethod.CASH,
              payer_cashbox_type: Cashbox_type.BRANCH,
              payer_user_id: BRANCH,
              created_by: MANAGER.id,
              dedup_epoch: `mm-race-${round}`,
            }),
        ],
        // Daftar bo'g'inlari (outbox relay) ham parallel.
        ['relay', () => relay()],
      ];
      const results = await Promise.allSettled(ops.map(([, op]) => op()));
      const failures = results
        .map((result, index) => ({ name: ops[index][0], result }))
        .filter(
          (entry): entry is { name: string; result: PromiseRejectedResult } =>
            entry.result.status === 'rejected',
        )
        .map((entry) => {
          const reason = entry.result.reason as {
            getError?: () => Row;
            message?: string;
          };
          const payload = reason?.getError?.() ?? {};
          return {
            name: entry.name,
            status: payload.statusCode,
            message: String(payload.message ?? reason?.message ?? ''),
          };
        });
      // Deadlock (40P01) yoki 500 yo'q — rad etilsa faqat biznes 400.
      for (const failure of failures) {
        expect(failure.message).not.toMatch(/deadlock/i);
        expect(failure.status).toBe(400);
      }
      expect(failures.map((f) => f.name)).not.toContain('rollback');
      await relay();
      await assertInvariants();
      expect(await orderStatus('7001')).toBe(Order_status.WAITING);
      expect(await saleRow('7001')).toBeUndefined();

      // Takroriy rollback (o'sha kalit) — ikkinchi marta yozilmaydi.
      const before = await snapshot();
      await expect(
        lifecycle.rollbackOrderToWaiting(
          (round % 2 ? MANAGER : SUPERADMIN) as never,
          '7001',
          undefined,
          `rb-race-${round}`,
        ),
      ).rejects.toBeDefined();
      await relay();
      expect(await snapshot()).toEqual(before);
      await assertInvariants();
    },
    120_000,
  );

  it('⭐ ro`yxat (partiya, bitta so`rov) ≡ bitta buyurtma qarori ≡ endpoint — aralash holatlar, uch rol', async () => {
    // 7001 PENDING; 7002 COURIER_SETTLED; 7003 BRANCH_SETTLED (menejer sotuvi);
    // 7004 bekor, HQ'da; 7005 bekor, kuryerda; 7006 cancelled (sent).
    await addOrder('7003', {
      holder_type: 'BRANCH',
      holder_courier_id: null,
      courier_id: null,
      post_id: 9002,
    });
    await sell(MANAGER, '7003');
    await branchPaysHq(PRICE, 'bp-list');
    await addOrder('7001');
    await addOrder('7002');
    await sell(COURIER, '7002');
    await courierPays(COURIER_SHARE, 'cp-list');
    await sell(COURIER, '7001');
    for (const id of ['7004', '7005', '7006']) {
      await addOrder(id);
      await cancel(COURIER, id);
    }
    await orderDb.query(
      `UPDATE "${orderSchema}".orders SET holder_type = 'HQ', holder_courier_id = NULL,
         holder_branch_id = NULL, branch_id = $1 WHERE id = '7004'`,
      [BRANCH],
    );
    await orderDb.query(
      `UPDATE "${orderSchema}".orders SET status = 'cancelled (sent)', canceled_post_id = 9100
        WHERE id = '7006'`,
    );
    const ids = ['7001', '7002', '7003', '7004', '7005', '7006'];
    for (const actor of [MANAGER, SUPERADMIN, COURIER, NO_PERMISSION_MANAGER]) {
      const batch: Row = await lifecycle.rollbackEligibilityForIds(ids, actor);
      const byId = new Map(
        (batch.data.items as Row[]).map((item) => [item.order_id, item]),
      );
      for (const id of ids) {
        const single = await listDecision(actor, id);
        expect({ actor: actor.id, id, ...byId.get(id) }).toEqual({
          actor: actor.id,
          id,
          ...single,
        });
        // Endpoint bilan moslik: rad etilsa — AYNI kod va matn (hech narsa
        // yozilmaydi); ruxsat — endpoint ham ruxsat beradi (yozmasdan:
        // `listDecision` endpoint bilan bir xil yuklovchidan).
        if (!single.allowed) {
          const error = await rejection(actor, id, `rb-list-${actor.id}-${id}`);
          expect(error).toMatchObject({
            code: single.code,
            message: single.message,
          });
        }
      }
    }
    // Kutilgan qarorlar (menejer).
    const manager: Row = await lifecycle.rollbackEligibilityForIds(
      ids,
      MANAGER,
    );
    expect(
      Object.fromEntries(
        (manager.data.items as Row[]).map((item) => [
          item.order_id,
          item.allowed ? 'ok' : item.code,
        ]),
      ),
    ).toEqual({
      '7001': 'ok',
      '7002': 'ok',
      '7003': 'SUPERADMIN_ONLY',
      '7004': 'PARCEL_NOT_IN_BRANCH',
      '7005': 'ok',
      '7006': 'PARCEL_NOT_IN_BRANCH',
    });
  }, 120_000);

  it('D3: menejerda `can_sell_cancel` yo`q — 403 NO_PERMISSION (ro`yxat ham)', async () => {
    await addOrder('7001');
    await sell(COURIER, '7001');
    await deniedRollback(NO_PERMISSION_MANAGER, '7001', 'NO_PERMISSION', 403);
  }, 60_000);
});
