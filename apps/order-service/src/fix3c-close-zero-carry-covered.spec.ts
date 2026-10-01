/**
 * fix3c (MONEY-02) — superadmin krediti → AYNI summaga qayta sotuv → sof-nol
 * yopish (`order.settlement.close_zero_courier_rows`) QOLDIQ hisobidan.
 *
 * Muammo: fix3b dan keyin superadmin topshirilgan (COURIER_SETTLED) sotuvni
 * qaytarsa, kuryer topshirgan summa uning `courier_to_branch` qoldig'iga
 * kredit bo'ladi. O'sha kuryer buyurtmani AYNI summaga qayta sotsa daftar
 * balansda (kassa 0 = Σ PENDING − qoldiq), lekin yangi PENDING qatorni hech
 * narsa yopa olmasdi: finance 0 so'mni qabul qilmaydi, advance faqat musbat
 * summada ishlaydi, sof-nol yopish esa qoldiq 0 bo'lishini talab qilardi —
 * kuryerni o'tkazish/chiqarish (qaror #4) uning keyingi to'lovigacha 409.
 *
 * Endi qoldiq musbat va PENDING yig'indisiga AYNAN teng (butun tiyin) bo'lsa,
 * qatorlar ODDIY FIFO sikli bilan qoldiq hisobidan yopiladi, qoldiq 0 bo'ladi,
 * so'ng odatdagi kaskad. Natija — kuryer to'lovi kelib eski qoldiq qatorlarni
 * qoplagandagi bilan AYNAN bir xil.
 *
 * Garnitura — BE-1 ning xotiradagi tranzaksion "dunyo"si
 * (`fix3b-sa-rollback-courier-credit.spec.ts`) nusxasi: HAQIQIY `sellOrder` /
 * `rollbackOrderToWaiting` / `advanceSettlement` / `closeZeroCourierRows`.
 * Qo'shimchalari: tranzaksiya hodisalari (qulf tartibi uchun), MAIN kassasi,
 * filial → HQ va HQ → market to'lovlari, `postLeg` yozuvchisi. Daftar ↔ kassa:
 *   kuryer kassasi = Σ PENDING courier_amount − kuryer qoldig'i
 *   filial kassasi = Σ COURIER_SETTLED branch_amount − filial→HQ qoldig'i
 *                    + filial kuryerlari qoldig'i
 *   market kassasi = Σ (MARKET_SETTLED emas) market_amount − HQ→market qoldig'i
 *   MAIN kassasi   = Σ (BRANCH/MARKET_SETTLED) branch_amount + filial→HQ
 *                    qoldig'i − Σ MARKET_SETTLED market_amount − HQ→market qoldig'i
 */
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import {
  Cashbox_type,
  IdempotencyKey,
  Operation_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { Order, OrderHolderType } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

type Row = Record<string, any>;

const HQ_ID = '1';
const BRANCH = '77';
const OTHER_BRANCH = '78';
const COURIER_ID = '289';
const MARKET_ID = '501';
const MAIN_USER = '0';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: BRANCH };
const MANAGER = { id: '201', roles: ['manager'], branch_id: BRANCH };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

/** 165 000 − kuryer tarifi 25 000 (markaz). */
const C_A = 140000;
/** 165 000 − market tarifi 30 000 (markaz). */
const M_A = 135000;

const clone = <T>(value: T): T => structuredClone(value);
const money = (n: number) => Math.round(n * 100) / 100;

/** TypeORM `where` — oddiy tenglik va `In()` (FindOperator `_value`). */
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '_value' in expected) {
      const values = (expected as { _value: unknown })._value;
      return Array.isArray(values)
        ? values.includes(row[key])
        : row[key] === values;
    }
    return row[key] === expected;
  });

type CloseReply = {
  statusCode: number;
  closed_count: number;
  data: {
    courier_id: string;
    closed_count: number;
    closed_order_ids: string[];
    skipped_reason: string | null;
  };
};

type FifoParams = Row & {
  carryLevel?: string;
  postLeg: (manager: unknown, row: Row, amount: number) => Promise<void>;
};
type FifoFn = (params: FifoParams) => Promise<Row>;

// ─────────────────────────── xotiradagi dunyo ───────────────────────────

function makeWorld(opts: { carryTable?: boolean } = {}) {
  const state = {
    cash: {} as Record<string, number>,
    orders: {} as Record<string, Row>,
    settlements: [] as Row[],
    carries: [] as Row[],
    idem: [] as Row[],
  };
  let seq = 0;
  const events: string[] = [];
  const cashKey = (type: string, user: string) => `${type}:${user}`;
  const applyCash = (payload: Row) => {
    const key = cashKey(payload.cashbox_type, String(payload.user_id));
    const sign = payload.operation_type === Operation_type.INCOME ? 1 : -1;
    state.cash[key] = money(
      (state.cash[key] ?? 0) + sign * Number(payload.amount),
    );
  };
  const move = (from: [Cashbox_type, string], to: [Cashbox_type, string]) =>
    function (amount: number) {
      applyCash({
        cashbox_type: from[0],
        user_id: from[1],
        amount,
        operation_type: Operation_type.EXPENSE,
      });
      applyCash({
        cashbox_type: to[0],
        user_id: to[1],
        amount,
        operation_type: Operation_type.INCOME,
      });
    };

  // ── repolar (tranzaksiya ichida ham, tashqarida ham AYNI holat) ──
  const orderRepo = {
    findOne: jest.fn((o: { where: Row }) =>
      Promise.resolve(
        state.orders[o.where.id] ? clone(state.orders[o.where.id]) : null,
      ),
    ),
    find: jest.fn(() => Promise.resolve([])),
    save: jest.fn((value: Row) => {
      const plain = { ...value };
      delete plain.items;
      state.orders[String(value.id)] = clone(plain);
      return Promise.resolve(value);
    }),
  };
  const sortRows = (rows: Row[], order?: Row) => {
    if (order?.createdAt) {
      const dir = order.createdAt === 'DESC' ? -1 : 1;
      return [...rows].sort((a, b) => dir * (a.createdAt - b.createdAt));
    }
    return rows;
  };
  const settlementRepo = {
    find: jest.fn((o: { where?: Row; order?: Row }) => {
      events.push('read:settlements');
      return Promise.resolve(
        sortRows(
          state.settlements.filter((r) => matches(r, o?.where)),
          o?.order,
        ).map(clone),
      );
    }),
    findOne: jest.fn((o: { where?: Row; order?: Row; lock?: Row }) => {
      const row = sortRows(
        state.settlements.filter((r) => matches(r, o?.where)),
        o?.order,
      )[0];
      if (o?.lock && row) events.push(`lock:settlement:${row.order_id}`);
      return Promise.resolve(row ? clone(row) : null);
    }),
    create: jest.fn((fields: Row) => ({ ...fields })),
    save: jest.fn((row: Row) => {
      const saved = { ...row, id: `s${++seq}`, createdAt: seq };
      state.settlements.push(saved);
      return Promise.resolve(clone(saved));
    }),
    update: jest.fn((criteria: Row, patch: Row) => {
      for (const row of state.settlements.filter((r) => matches(r, criteria))) {
        Object.assign(row, patch);
      }
      return Promise.resolve({ affected: 1 });
    }),
    createQueryBuilder: jest.fn(() => {
      let patch: Row = {};
      let orderId = '';
      const qb = {
        update: () => qb,
        set: (p: Row) => {
          patch = p;
          return qb;
        },
        where: (_sql: string, params: Row) => {
          orderId = String(params.orderId);
          return qb;
        },
        execute: () => {
          for (const row of state.settlements.filter(
            (r) => r.order_id === orderId,
          )) {
            Object.assign(row, patch);
          }
          return Promise.resolve({ affected: 1 });
        },
      };
      return qb;
    }),
  };
  const carryRepo = {
    createQueryBuilder: jest.fn(() => {
      let values: Row = {};
      const qb = {
        insert: () => qb,
        values: (v: Row) => {
          values = v;
          return qb;
        },
        orIgnore: () => qb,
        execute: () => {
          if (
            !state.carries.some(
              (c) => c.level === values.level && c.party_id === values.party_id,
            )
          ) {
            state.carries.push({
              id: `c${++seq}`,
              isDeleted: false,
              branch_id: null,
              amount: 0,
              ...values,
            });
          }
          return Promise.resolve({});
        },
      };
      return qb;
    }),
    findOne: jest.fn((o: { where?: Row; lock?: Row }) => {
      const row = state.carries.find((c) => matches(c, o?.where));
      if (o?.lock && row)
        events.push(`lock:carry:${row.level}:${row.party_id}`);
      return Promise.resolve(row ? clone(row) : null);
    }),
    find: jest.fn((o: { where?: Row }) =>
      Promise.resolve(
        state.carries.filter((c) => matches(c, o?.where)).map(clone),
      ),
    ),
    update: jest.fn((criteria: Row, patch: Row) => {
      for (const row of state.carries.filter((c) => matches(c, criteria))) {
        Object.assign(row, patch);
      }
      return Promise.resolve({ affected: 1 });
    }),
  };
  const idemRepo = {
    findOne: jest.fn((o: { where?: Row }) =>
      Promise.resolve(state.idem.find((k) => matches(k, o?.where)) ?? null),
    ),
    insert: jest.fn((row: Row) => {
      state.idem.push({ ...row });
      return Promise.resolve({});
    }),
    update: jest.fn((criteria: Row, patch: Row) => {
      for (const row of state.idem.filter((k) => matches(k, criteria))) {
        Object.assign(row, patch);
      }
      return Promise.resolve({});
    }),
  };
  const repoFor = (entity: unknown): Row => {
    if (entity === Order) return orderRepo;
    if (entity === OrderSettlement) return settlementRepo;
    if (entity === OrderSettlementCarry) return carryRepo;
    if (entity === IdempotencyKey) return idemRepo;
    return {};
  };

  // ── tranzaksiya: boshlanishda snapshot, rollbackda qaytariladi; kassa
  //    hodisalari (outbox) faqat commit'da qo'llanadi ──
  const managers = new Map<object, Row[]>();
  const dataSource = {
    options: { schema: 'order_schema' },
    query: jest.fn(() =>
      Promise.resolve([
        { t: opts.carryTable === false ? null : 'order_settlement_carry' },
      ]),
    ),
    getRepository: jest.fn(repoFor),
    createQueryRunner: jest.fn(() => {
      let snapshot: typeof state | null = null;
      const manager = { getRepository: jest.fn(repoFor) };
      const runner = {
        manager,
        connect: jest.fn(),
        release: jest.fn(),
        startTransaction: jest.fn(() => {
          events.push('tx:begin');
          snapshot = clone(state);
          managers.set(manager, []);
        }),
        commitTransaction: jest.fn(() => {
          events.push('tx:commit');
          for (const payload of managers.get(manager) ?? []) applyCash(payload);
          managers.delete(manager);
        }),
        rollbackTransaction: jest.fn(() => {
          events.push('tx:rollback');
          if (snapshot) Object.assign(state, snapshot);
          managers.delete(manager);
        }),
      };
      return runner;
    }),
  };
  const outbox = {
    enqueue: jest.fn(
      (
        _target: string,
        cmd: string,
        payload: Row,
        o?: { manager?: object },
      ) => {
        if (cmd !== 'finance.cashbox.update_balance') return Promise.resolve();
        const buffer = o?.manager ? managers.get(o.manager) : undefined;
        if (buffer) buffer.push(payload);
        else applyCash(payload);
        return Promise.resolve();
      },
    ),
  };

  const lookup = {
    getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
    getMarketsByIds: jest.fn().mockResolvedValue([
      {
        id: MARKET_ID,
        tariff_center: 30000,
        tariff_home: 45000,
        expense_proof_conditions: [],
      },
    ]),
    getCouriersByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids.map((id) => ({
          id,
          tariff_center: 25000,
          tariff_home: 35000,
          can_add_extra_cost: true,
        })),
      ),
    ),
    getUserById: jest.fn().mockResolvedValue(null),
    getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
      Promise.resolve({
        id: `${type}-${userId}`,
        balance: state.cash[cashKey(type, userId)] ?? 0,
      }),
    ),
    ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
    resolveSettlementBranchId: jest.fn().mockResolvedValue(BRANCH),
    resolveBranchShare: jest.fn().mockResolvedValue(0),
    getBranchAssignmentByUserStrict: jest
      .fn()
      .mockResolvedValue({ branch_id: BRANCH, role: 'COURIER' }),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const lifecycle = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(lifecycle, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource,
    orderSettlementRepo: settlementRepo,
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: COURIER_ID } })),
    },
    outbox,
    activityLog,
    lookup,
    custody: {
      auditActor: jest.fn(() => ({})),
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'courier'),
    },
    findById: jest.fn((id: string) =>
      Promise.resolve({ ...clone(state.orders[String(id)]), items: [] }),
    ),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  const svc = lifecycle as unknown as OrderLifecycleService;

  const settlement = new OrderSettlementService(
    dataSource as never,
    settlementRepo as never,
    {} as never,
    lookup as never,
  );

  const cash = (type: Cashbox_type, user: string) =>
    state.cash[cashKey(type, user)] ?? 0;
  const carry = (level: string, party: string) =>
    Number(
      state.carries.find((c) => c.level === level && c.party_id === party)
        ?.amount ?? 0,
    );
  const carryRow = (level: string, party: string) =>
    state.carries.find((c) => c.level === level && c.party_id === party);
  const rowOf = (orderId: string) =>
    state.settlements.find((r) => r.order_id === orderId);

  /** Daftar ↔ kassa tengligi (fayl boshidagi izoh). */
  const assertLedgerMatchesCash = () => {
    const active = state.settlements.filter((r) => !r.isDeleted);
    const sum = (rows: Row[], field: string) =>
      money(rows.reduce((acc, r) => acc + Number(r[field] ?? 0), 0));
    const rowsWhere = (pred: (r: Row) => boolean) => active.filter(pred);

    expect(cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(
      money(
        sum(
          rowsWhere(
            (r) =>
              r.status === SettlementStatus.PENDING &&
              r.courier_id === COURIER_ID,
          ),
          'courier_amount',
        ) - carry('courier_to_branch', COURIER_ID),
      ),
    );

    const branchCourierCarries = money(
      state.carries
        .filter(
          (c) => c.level === 'courier_to_branch' && c.branch_id === BRANCH,
        )
        .reduce((acc, c) => acc + Number(c.amount ?? 0), 0),
    );
    expect(cash(Cashbox_type.BRANCH, BRANCH)).toBe(
      money(
        sum(
          rowsWhere(
            (r) =>
              r.status === SettlementStatus.COURIER_SETTLED &&
              r.branch_id === BRANCH,
          ),
          'branch_amount',
        ) -
          carry('branch_to_hq', BRANCH) +
          branchCourierCarries,
      ),
    );

    expect(cash(Cashbox_type.FOR_MARKET, MARKET_ID)).toBe(
      money(
        sum(
          rowsWhere(
            (r) =>
              r.market_id === MARKET_ID &&
              r.status !== SettlementStatus.MARKET_SETTLED,
          ),
          'market_amount',
        ) - carry('hq_to_market', MARKET_ID),
      ),
    );

    const atHq = (r: Row) =>
      r.branch_id === BRANCH &&
      (r.status === SettlementStatus.BRANCH_SETTLED ||
        r.status === SettlementStatus.MARKET_SETTLED);
    expect(cash(Cashbox_type.MAIN, MAIN_USER)).toBe(
      money(
        sum(rowsWhere(atHq), 'branch_amount') +
          carry('branch_to_hq', BRANCH) -
          sum(
            rowsWhere(
              (r) =>
                r.market_id === MARKET_ID &&
                r.status === SettlementStatus.MARKET_SETTLED,
            ),
            'market_amount',
          ) -
          carry('hq_to_market', MARKET_ID),
      ),
    );
  };

  /** finance `payment_courier` (qabul qiluvchi — filial kassasi) + FIFO. */
  let payments = 0;
  const courierPays = (amount: number, opts: { force?: boolean } = {}) => {
    if (!opts.force) {
      // finance: summa kuryer kassasidan oshmasin.
      expect(amount).toBeLessThanOrEqual(
        cash(Cashbox_type.FOR_COURIER, COURIER_ID),
      );
    }
    move(
      [Cashbox_type.FOR_COURIER, COURIER_ID],
      [Cashbox_type.BRANCH, BRANCH],
    )(amount);
    payments += 1;
    return settlement.advanceSettlement({
      level: 'courier_to_branch',
      match_value: COURIER_ID,
      amount,
      requester_id: MANAGER.id,
      request_id: `pay-${payments}`,
    });
  };
  /** SA filial pulini "Qabul qilinishi kerak" dan oladi (qaror #7) + FIFO. */
  const branchPaysHq = (amount: number) => {
    move([Cashbox_type.BRANCH, BRANCH], [Cashbox_type.MAIN, MAIN_USER])(amount);
    payments += 1;
    return settlement.advanceSettlement({
      level: 'branch_to_hq',
      match_value: BRANCH,
      amount,
      requester_id: SUPERADMIN.id,
      request_id: `b2h-${payments}`,
    });
  };
  /** SA marketga to'laydi (MAIN → market) + FIFO. */
  const hqPaysMarket = (amount: number) => {
    applyCash({
      cashbox_type: Cashbox_type.MAIN,
      user_id: MAIN_USER,
      amount,
      operation_type: Operation_type.EXPENSE,
    });
    applyCash({
      cashbox_type: Cashbox_type.FOR_MARKET,
      user_id: MARKET_ID,
      amount,
      operation_type: Operation_type.EXPENSE,
    });
    payments += 1;
    return settlement.advanceSettlement({
      level: 'hq_to_market',
      match_value: MARKET_ID,
      amount,
      requester_id: SUPERADMIN.id,
      request_id: `h2m-${payments}`,
    });
  };

  const closeZero = (requester: { id: string; roles: string[] } = MANAGER) =>
    settlement.closeZeroCourierRows({
      courier_id: COURIER_ID,
      requester: { id: requester.id, roles: requester.roles },
    }) as Promise<CloseReply>;

  /**
   * `runFifoSettlement` ning HAR chaqiruvidagi `postLeg` ni yozib boradi
   * (bo'g'in:buyurtma:summa) — sof-nol yopish va oddiy FIFO bir xil
   * oyoqlarni chaqirishini solishtirish uchun.
   */
  const recordPostLegs = () => {
    const calls: string[] = [];
    const target = settlement as unknown as { runFifoSettlement: FifoFn };
    const original = target.runFifoSettlement.bind(settlement);
    target.runFifoSettlement = (params) =>
      original({
        ...params,
        postLeg: async (manager, row, amount) => {
          calls.push(`${params.carryLevel ?? '-'}:${row.order_id}:${amount}`);
          await params.postLeg(manager, row, amount);
        },
      });
    return calls;
  };

  /** Sozlangan daftar holati (lifecycle'siz) — kichik holatlar uchun. */
  const seedRow = (fields: Row) => {
    seq += 1;
    const row: Row = {
      id: `s${seq}`,
      createdAt: seq,
      courier_id: COURIER_ID,
      branch_id: BRANCH,
      market_id: MARKET_ID,
      courier_amount: 0,
      branch_amount: 0,
      market_amount: 0,
      status: SettlementStatus.PENDING,
      courier_to_branch_at: null,
      courier_to_branch_by: null,
      branch_to_hq_at: null,
      branch_to_hq_by: null,
      hq_to_market_at: null,
      hq_to_market_by: null,
      isDeleted: false,
      ...fields,
    };
    state.settlements.push(row);
    return row;
  };
  const seedCarry = (fields: Row) => {
    seq += 1;
    const row: Row = {
      id: `c${seq}`,
      isDeleted: false,
      branch_id: null,
      amount: 0,
      ...fields,
    };
    state.carries.push(row);
    return row;
  };

  const addOrder = (id: string, total: number) => {
    state.orders[id] = {
      id,
      status: Order_status.WAITING,
      post_id: '9001',
      market_id: MARKET_ID,
      customer_id: '801',
      total_price: total,
      paid_online_amount: 0,
      where_deliver: Where_deliver.CENTER,
      market_tariff: null,
      courier_tariff: null,
      courier_share: null,
      branch_share: null,
      branch_cashbox_amount: null,
      sale_collectible_amount: null,
      extra_cost: 0,
      to_be_paid: 0,
      paid_amount: 0,
      return_requested: false,
      branch_id: BRANCH,
      home_branch_id: BRANCH,
      holder_type: OrderHolderType.COURIER,
      holder_branch_id: BRANCH,
      holder_courier_id: COURIER_ID,
      courier_id: COURIER_ID,
      operator_id: null,
      sold_at: null,
      comment: null,
      source: 'internal',
      isDeleted: false,
    };
  };

  return {
    svc,
    settlement,
    state,
    events,
    outbox,
    activityLog,
    cash,
    carry,
    carryRow,
    rowOf,
    addOrder,
    courierPays,
    branchPaysHq,
    hqPaysMarket,
    closeZero,
    recordPostLegs,
    seedRow,
    seedCarry,
    assertLedgerMatchesCash,
  };
}

type World = ReturnType<typeof makeWorld>;

/**
 * Sotuv → topshirish → superadmin rollback (kredit) → [filial puli HQ'ga] →
 * AYNI summaga qayta sotuv → [HQ marketga oldindan to'laydi]. Natija: kuryer
 * kassasi 0, Σ PENDING = qoldiq = 140 000 — aynan MONEY-02 holati.
 */
async function reSoldWorld(
  opts: { remitBranchToHq?: boolean; prepayMarket?: boolean } = {},
): Promise<World> {
  const w = makeWorld();
  w.addOrder('7001', 165000);
  await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
  await w.courierPays(C_A);
  expect(w.rowOf('7001')?.status).toBe(SettlementStatus.COURIER_SETTLED);

  await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');
  expect(w.carry('courier_to_branch', COURIER_ID)).toBe(C_A);
  expect(w.carryRow('courier_to_branch', COURIER_ID)?.branch_id).toBe(BRANCH);
  w.assertLedgerMatchesCash();

  if (opts.remitBranchToHq) {
    // Filialda o'sha 140 000 turibdi — SA uni qabul qiladi; COURIER_SETTLED
    // qator yo'q, ya'ni hammasi filial → HQ qoldig'i bo'ladi.
    await w.branchPaysHq(C_A);
    expect(w.carry('branch_to_hq', BRANCH)).toBe(C_A);
    w.assertLedgerMatchesCash();
  }

  await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a-2');
  expect(w.rowOf('7001')).toMatchObject({
    status: SettlementStatus.PENDING,
    isDeleted: false,
    courier_amount: C_A,
    branch_amount: C_A,
    market_amount: M_A,
  });

  if (opts.prepayMarket) {
    await w.hqPaysMarket(M_A);
    expect(w.carry('hq_to_market', MARKET_ID)).toBe(M_A);
  }

  expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(0);
  w.assertLedgerMatchesCash();
  return w;
}

/** Solishtirish uchun qatorlar (vaqt belgilari — faqat bor/yo'qligi). */
const ledgerView = (w: World) =>
  [...w.state.settlements]
    .sort((a, b) => String(a.order_id).localeCompare(String(b.order_id)))
    .map((r) => ({
      order_id: r.order_id,
      status: r.status,
      isDeleted: r.isDeleted,
      courier_amount: r.courier_amount,
      branch_amount: r.branch_amount,
      market_amount: r.market_amount,
      courier_to_branch_by: r.courier_to_branch_by,
      branch_to_hq_by: r.branch_to_hq_by,
      hq_to_market_by: r.hq_to_market_by,
      courier_to_branch_at: r.courier_to_branch_at instanceof Date,
      branch_to_hq_at: r.branch_to_hq_at instanceof Date,
      hq_to_market_at: r.hq_to_market_at instanceof Date,
    }));
const carriesView = (w: World) =>
  [...w.state.carries]
    .sort((a, b) =>
      `${a.level}:${a.party_id}`.localeCompare(`${b.level}:${b.party_id}`),
    )
    .map((c) => ({
      level: c.level,
      party_id: c.party_id,
      branch_id: c.branch_id,
      amount: Number(c.amount),
    }));
const snapshotOf = (w: World) =>
  clone({
    cash: w.state.cash,
    settlements: w.state.settlements,
    carries: w.state.carries,
  });

let logSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────── ⭐ asosiy zanjir ───────────────────────────

describe('⭐ MONEY-02 — SA krediti → AYNI summaga qayta sotuv → sof-nol yopish qoldiq hisobidan', () => {
  it('qator COURIER_SETTLED, qoldiq 0, kassalar o`zgarmaydi; keyingi oddiy sotuv + to`lov ham ishlaydi', async () => {
    const w = await reSoldWorld();
    const cashBefore = clone(w.state.cash);
    w.events.length = 0;
    w.outbox.enqueue.mockClear();
    w.activityLog.log.mockClear();

    const res = await w.closeZero(MANAGER);

    expect(res.statusCode).toBe(200);
    expect(res.closed_count).toBe(1);
    expect(res.data).toEqual({
      courier_id: COURIER_ID,
      closed_count: 1,
      closed_order_ids: ['7001'],
      skipped_reason: null,
    });
    expect(w.rowOf('7001')).toMatchObject({
      status: SettlementStatus.COURIER_SETTLED,
      courier_to_branch_by: MANAGER.id,
      isDeleted: false,
    });
    expect(w.rowOf('7001')?.courier_to_branch_at).toBeInstanceOf(Date);
    // Qoldiq to'liq sarflandi, filiali o'sha (naqd o'sha filialda).
    expect(w.carryRow('courier_to_branch', COURIER_ID)).toMatchObject({
      amount: 0,
      branch_id: BRANCH,
    });
    // Pul KO'CHMAYDI — faqat daftar yopiladi.
    expect(w.state.cash).toEqual(cashBefore);
    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(0);
    expect(w.cash(Cashbox_type.BRANCH, BRANCH)).toBe(C_A);
    expect(w.outbox.enqueue).not.toHaveBeenCalled();
    expect(w.activityLog.log).not.toHaveBeenCalled();
    // Avtomatik yopishda sarflangan qoldiq logda (tashxis uchun).
    expect(logSpy).toHaveBeenCalledWith(
      `Net-zero courier rows closed: courier=${COURIER_ID} count=1 carry_used=${C_A} by=${MANAGER.id}`,
    );
    w.assertLedgerMatchesCash();
    // BITTA tranzaksiya: qoldiq qulfi → qatorlar → commit (kaskadga
    // qoldiq yo'q — boshqa tranzaksiya ochilmaydi).
    expect(w.events).toEqual([
      'tx:begin',
      `lock:carry:courier_to_branch:${COURIER_ID}`,
      'read:settlements',
      'tx:commit',
    ]);

    // Ikkinchi chaqiruv xavfsiz — yopiladigan qator yo'q.
    const again = await w.closeZero(MANAGER);
    expect(again.closed_count).toBe(0);
    expect(again.data.skipped_reason).toBe('no_pending_rows');
    expect(w.state.cash).toEqual(cashBefore);

    // Keyingi ODDIY sotuv + to'lov: 100 000 − 25 000 = 75 000.
    w.addOrder('7002', 100000);
    await w.svc.sellOrder(COURIER, '7002', {}, 'sell-b');
    w.assertLedgerMatchesCash();
    await w.courierPays(75000);
    expect(w.rowOf('7002')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(0);
    expect(w.cash(Cashbox_type.BRANCH, BRANCH)).toBe(C_A + 75000);
    w.assertLedgerMatchesCash();
  });

  it('⭐ kaskad: filial → HQ va HQ → market qoldiqlari oddiy FIFO dagidek darhol qo`llanadi', async () => {
    const w = await reSoldWorld({ remitBranchToHq: true, prepayMarket: true });
    w.events.length = 0;

    const res = await w.closeZero(MANAGER);

    expect(res.closed_count).toBe(1);
    // courier → branch (qoldiq hisobidan), so'ng filialning HQ'ga oldindan
    // topshirgan qoldig'i bilan branch → HQ, so'ng HQ'ning marketga oldindan
    // to'lagani bilan HQ → market.
    expect(w.rowOf('7001')).toMatchObject({
      status: SettlementStatus.MARKET_SETTLED,
      courier_to_branch_by: MANAGER.id,
      branch_to_hq_by: MANAGER.id,
      hq_to_market_by: MANAGER.id,
    });
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(w.carry('branch_to_hq', BRANCH)).toBe(0);
    expect(w.carry('hq_to_market', MARKET_ID)).toBe(0);
    w.assertLedgerMatchesCash();
    // Qulf tartibi o'zgarmagan: har bo'g'in o'z tranzaksiyasida, kuryer →
    // filial → market ketma-ket (ichma-ich qulf yo'q).
    expect(w.events).toEqual([
      'tx:begin',
      `lock:carry:courier_to_branch:${COURIER_ID}`,
      'read:settlements',
      'tx:commit',
      'tx:begin',
      `lock:carry:branch_to_hq:${BRANCH}`,
      'read:settlements',
      'tx:commit',
      'tx:begin',
      `lock:carry:hq_to_market:${MARKET_ID}`,
      'read:settlements',
      'tx:commit',
    ]);
  });

  it('⭐ oddiy FIFO bilan AYNAN bir xil: to`lov kelib qoldiq qatorni qoplagandagi holatlar, postLeg va kaskad', async () => {
    // A — sof-nol yopish; B — xuddi shu dunyoga (faraziy) 1 so'm to'lov:
    // lump-sum 1 + qoldiq 140 000 — oddiy FIFO yo'li.
    const a = await reSoldWorld({ remitBranchToHq: true, prepayMarket: true });
    const b = await reSoldWorld({ remitBranchToHq: true, prepayMarket: true });
    const legsA = a.recordPostLegs();
    const legsB = b.recordPostLegs();

    await a.closeZero(MANAGER);
    await b.courierPays(1, { force: true });

    expect(ledgerView(a)).toEqual(ledgerView(b));
    expect(legsA).toEqual(legsB);
    expect(legsA).toEqual([
      `courier_to_branch:7001:${C_A}`,
      `branch_to_hq:7001:${C_A}`,
      `hq_to_market:7001:${M_A}`,
    ]);
    // Yagona farq — B dagi faraziy 1 so'm (u kuryer qoldig'i bo'lib qoladi).
    expect(carriesView(a)).toEqual(
      carriesView(b).map((c) =>
        c.level === 'courier_to_branch' ? { ...c, amount: c.amount - 1 } : c,
      ),
    );
    expect(a.carry('courier_to_branch', COURIER_ID)).toBe(0);
    a.assertLedgerMatchesCash();
    b.assertLedgerMatchesCash();
  });

  it('⭐ yopish + keyingi sotuv/to`lov ≡ yopishsiz keyingi sotuv/to`lov (yakuniy daftar, qoldiq, kassa bir xil)', async () => {
    const a = await reSoldWorld({ remitBranchToHq: true });
    const b = await reSoldWorld({ remitBranchToHq: true });
    const legsA = a.recordPostLegs();
    const legsB = b.recordPostLegs();

    expect((await a.closeZero(MANAGER)).closed_count).toBe(1);
    for (const w of [a, b]) {
      w.addOrder('7002', 100000);
      await w.svc.sellOrder(COURIER, '7002', {}, 'sell-b');
      await w.courierPays(75000);
      w.assertLedgerMatchesCash();
    }

    expect(ledgerView(a)).toEqual(ledgerView(b));
    expect(carriesView(a)).toEqual(carriesView(b));
    expect(a.state.cash).toEqual(b.state.cash);
    // Oyoqlar AYNI (A: yopishda 7001 + uning kaskadi, to'lovda 7002; B: bitta
    // to'lovda ikkalasi, so'ng kaskad) — faqat tartibi farq qiladi.
    expect([...legsA].sort()).toEqual([...legsB].sort());
    expect([...legsA].sort()).toEqual([
      `branch_to_hq:7001:${C_A}`,
      `courier_to_branch:7001:${C_A}`,
      'courier_to_branch:7002:75000',
    ]);
    expect(a.rowOf('7001')?.status).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(a.rowOf('7002')?.status).toBe(SettlementStatus.COURIER_SETTLED);
  });
});

// ─────────────────────────── kichik holatlar ───────────────────────────

describe('MONEY-02 — qoldiq qoplagan holatda oddiy FIFO sikli (kreditlar, HQ kuryeri)', () => {
  it('kredit qatori bilan: qoldiq 20 000 = 50 000 − 30 000 — ikkalasi yopiladi, postLeg faqat musbat oyoqqa (oddiy FIFO dagidek)', async () => {
    const build = () => {
      const w = makeWorld();
      w.seedRow({ order_id: 'A', courier_amount: 50000, branch_amount: 50000 });
      w.seedRow({
        order_id: 'B',
        courier_amount: -30000,
        branch_amount: -30000,
      });
      w.seedCarry({
        level: 'courier_to_branch',
        party_id: COURIER_ID,
        branch_id: BRANCH,
        amount: 20000,
      });
      return w;
    };
    const a = build();
    const b = build();
    const legsA = a.recordPostLegs();
    const legsB = b.recordPostLegs();

    const res = await a.closeZero();
    await b.courierPays(1, { force: true });

    expect(res.closed_count).toBe(2);
    expect(a.rowOf('A')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(a.rowOf('B')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(a.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(ledgerView(a)).toEqual(ledgerView(b));
    expect(legsA).toEqual(['courier_to_branch:A:50000']);
    expect(legsA).toEqual(legsB);
  });

  it('HQ kuryeri (filialsiz qatorlar, qoldiq filiali NULL): qatorlar BRANCH_SETTLED, HQ → market kaskadi', async () => {
    const build = () => {
      const w = makeWorld();
      w.seedRow({
        order_id: 'H1',
        branch_id: null,
        courier_amount: 60000,
        branch_amount: 60000,
        market_amount: 55000,
      });
      w.seedCarry({
        level: 'courier_to_branch',
        party_id: COURIER_ID,
        branch_id: null,
        amount: 60000,
      });
      w.seedCarry({
        level: 'hq_to_market',
        party_id: MARKET_ID,
        amount: 55000,
      });
      return w;
    };
    const a = build();
    const b = build();
    const legsA = a.recordPostLegs();
    const legsB = b.recordPostLegs();

    const res = await a.closeZero();
    await b.courierPays(1, { force: true });

    expect(res.closed_count).toBe(1);
    expect(a.rowOf('H1')?.status).toBe(SettlementStatus.MARKET_SETTLED);
    expect(a.carryRow('courier_to_branch', COURIER_ID)).toMatchObject({
      amount: 0,
      branch_id: null,
    });
    expect(a.carry('hq_to_market', MARKET_ID)).toBe(0);
    expect(ledgerView(a)).toEqual(ledgerView(b));
    expect(legsA).toEqual(legsB);
  });

  it('suzuvchi nuqta qoldig`i yozilmaydi: 0,70 + 0,10 = qoldiq 0,80 — sikl hammasini yopadi, qoldiq AYNAN 0', async () => {
    // Oddiy formula (0,8 − 0,7999…) 1,1e-16 qoldirardi; tiyinda teng ekani
    // qulf ostida tekshirilgan — qoldiq to'liq sarflangan.
    const w = makeWorld();
    w.seedRow({ order_id: 'A', courier_amount: 0.7, branch_amount: 0.7 });
    w.seedRow({ order_id: 'B', courier_amount: 0.1, branch_amount: 0.1 });
    w.seedCarry({
      level: 'courier_to_branch',
      party_id: COURIER_ID,
      branch_id: BRANCH,
      amount: 0.8,
    });

    const res = await w.closeZero();

    expect(res.closed_count).toBe(2);
    expect(w.carryRow('courier_to_branch', COURIER_ID)?.amount).toBe(0);
  });
});

// ─────────────────────────── rad etiladigan holatlar ───────────────────────────

describe('MONEY-02 — qoldiq yig`indiga teng bo`lmasa hech narsa o`zgarmaydi', () => {
  const expectRejected = async (w: World, reason: string) => {
    const before = snapshotOf(w);
    w.events.length = 0;

    const res = await w.closeZero();

    expect(res.statusCode).toBe(200);
    expect(res.closed_count).toBe(0);
    expect(res.data.closed_order_ids).toEqual([]);
    expect(res.data.skipped_reason).toBe(reason);
    expect(snapshotOf(w)).toEqual(before);
    // Tranzaksiya qaytarildi, kaskad ishlamadi.
    expect(w.events).toEqual([
      'tx:begin',
      `lock:carry:courier_to_branch:${COURIER_ID}`,
      'read:settlements',
      'tx:rollback',
    ]);
  };

  it('⭐ qayta sotuv BOSHQA summaga (xarajat 5 000: 135 000 ≠ qoldiq 140 000) — carry_not_zero', async () => {
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
    await w.courierPays(C_A);
    await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');
    await w.svc.sellOrder(
      COURIER,
      '7001',
      { extraCost: 5000, extraCostApproved: true },
      'sell-a-2',
    );
    expect(w.rowOf('7001')?.courier_amount).toBe(C_A - 5000);
    w.assertLedgerMatchesCash();

    await expectRejected(w, 'carry_not_zero');
  });

  it('1 tiyin farq (qoldiq 140 000,01) — carry_not_zero', async () => {
    const w = await reSoldWorld();
    w.carryRow('courier_to_branch', COURIER_ID)!.amount = 140000.01;

    await expectRejected(w, 'carry_not_zero');
  });

  it('manfiy qoldiq yig`indiga teng bo`lsa ham (−50 = −50) — carry_not_zero (qoldiq musbat bo`lishi shart)', async () => {
    const w = makeWorld();
    w.seedRow({ order_id: 'A', courier_amount: -50, branch_amount: -50 });
    w.seedCarry({
      level: 'courier_to_branch',
      party_id: COURIER_ID,
      branch_id: BRANCH,
      amount: -50,
    });

    await expectRejected(w, 'carry_not_zero');
  });

  it('⭐ qator boshqa filialniki (qoldiq 78 da, qator 77 da) — carry_branch_mismatch', async () => {
    const w = await reSoldWorld();
    w.carryRow('courier_to_branch', COURIER_ID)!.branch_id = OTHER_BRANCH;

    await expectRejected(w, 'carry_branch_mismatch');
  });

  it('qoldiq HQ kuryeriniki (NULL), qator filialniki — carry_branch_mismatch', async () => {
    const w = await reSoldWorld();
    w.carryRow('courier_to_branch', COURIER_ID)!.branch_id = null;

    await expectRejected(w, 'carry_branch_mismatch');
  });

  it('PENDING yig`indisi 0, qoldiq musbat — carry_not_zero (avvalgidek)', async () => {
    const w = makeWorld();
    w.seedRow({ order_id: 'A', courier_amount: 0 });
    w.seedCarry({
      level: 'courier_to_branch',
      party_id: COURIER_ID,
      branch_id: BRANCH,
      amount: 5000,
    });

    await expectRejected(w, 'carry_not_zero');
  });

  it('suzuvchi nuqta: qoldiq 0,30 = 0,10 + 0,20 (tiyinda teng), lekin oddiy sikl yarim yo`lda to`xtaydi — hammasi qaytariladi (not_fully_closed)', async () => {
    const w = makeWorld();
    w.seedRow({ order_id: 'A', courier_amount: 0.1, branch_amount: 0.1 });
    w.seedRow({ order_id: 'B', courier_amount: 0.2, branch_amount: 0.2 });
    w.seedCarry({
      level: 'courier_to_branch',
      party_id: COURIER_ID,
      branch_id: BRANCH,
      amount: 0.3,
    });

    await expectRejected(w, 'not_fully_closed');
  });

  it('kuryer kassasida pul bo`lsa ham order-service FAQAT daftarga qaraydi: Σ PENDING ≠ qoldiq — rad', async () => {
    // Masalan, yana bir sotuv (75 000) — Σ PENDING 215 000 ≠ qoldiq 140 000.
    const w = await reSoldWorld();
    w.addOrder('7002', 100000);
    await w.svc.sellOrder(COURIER, '7002', {}, 'sell-b');

    await expectRejected(w, 'carry_not_zero');
  });
});

// ─────────────────────────── C8 avvalgidek ───────────────────────────

describe('MONEY-02 — qoldiq 0 va yig`indi 0 (C8) yo`li o`zgarmagan', () => {
  it('qatorlar createdAt tartibida yopiladi, postLeg chaqirilmaydi, qoldiq qatori 0 ga (filiali eng eski qatordan) yoziladi', async () => {
    const w = makeWorld();
    w.seedRow({ order_id: 'A', courier_amount: 5000, branch_amount: 5000 });
    w.seedRow({
      order_id: 'B',
      courier_amount: -5000,
      branch_amount: -5000,
    });
    w.seedRow({ order_id: 'C', branch_id: null, courier_amount: 0 });
    const legs = w.recordPostLegs();
    w.events.length = 0;

    const res = await w.closeZero();

    expect(res.data).toEqual({
      courier_id: COURIER_ID,
      closed_count: 3,
      closed_order_ids: ['A', 'B', 'C'],
      skipped_reason: null,
    });
    expect(w.state.settlements.map((r) => r.status)).toEqual([
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ]);
    expect(legs).toEqual([]);
    // Log satri avvalgidek (qoldiq ishlatilmadi).
    expect(logSpy).toHaveBeenCalledWith(
      `Net-zero courier rows closed: courier=${COURIER_ID} count=3 by=${MANAGER.id}`,
    );
    expect(w.carryRow('courier_to_branch', COURIER_ID)).toMatchObject({
      amount: 0,
      branch_id: BRANCH,
    });
    expect(w.events).toEqual([
      'tx:begin',
      `lock:carry:courier_to_branch:${COURIER_ID}`,
      'read:settlements',
      'tx:commit',
    ]);
  });

  it('qoldiq jadvali yo`q muhit — sof-nol qatorlar avvalgidek yopiladi (qoldiq qulfi yo`q)', async () => {
    const w = makeWorld({ carryTable: false });
    w.seedRow({ order_id: 'A', courier_amount: 0 });
    w.events.length = 0;

    const res = await w.closeZero();

    expect(res.closed_count).toBe(1);
    expect(w.state.carries).toEqual([]);
    expect(w.events).toEqual(['tx:begin', 'read:settlements', 'tx:commit']);
  });
});
