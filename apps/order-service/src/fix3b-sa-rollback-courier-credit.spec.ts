/**
 * fix3b (M6) — SUPERADMIN kuryer topshirib bo'lgan (COURIER_SETTLED) sotuvni
 * XAVFSIZ qaytaradi.
 *
 * Hujjat: rollback chegarasi HQ ("HQ'ga yetgach taqiqlanadi"), superadmin —
 * tuzatish roli. fix3 (L1) esa COURIER_SETTLED dan keyin HAMMANI to'sgan edi:
 * xato kiritilib, puli topshirilgan sotuvni hech kim tuzata olmasdi.
 *
 * Endi:
 *   • kuryer va menejer — avvalgidek yopiq;
 *   • superadmin — rollback tranzaksiyasi ichida, `runFifoSettlement` dagi AYNI
 *     qoldiq qulfi ostida qatorning `courier_amount` i kuryerning
 *     `courier_to_branch` qoldig'iga qo'shiladi (kuryerning KEYINGI topshirig'iga
 *     kredit), so'ng oyoqlar kutilayotgan sotuvdagidek teskari yoziladi;
 *   • HQ'ga yetgan qator — hamma uchun yopiq (o'zgarmagan).
 *
 * ⭐ Asosiy test HAQIQIY `sellOrder` → HAQIQIY FIFO (`advanceSettlement`) →
 * HAQIQIY `rollbackOrderToWaiting` → qayta sotuv → keyingi FIFO zanjirini
 * xotiradagi "dunyo"da (kassalar + settlement + qoldiq) yuritadi va har
 * qadamda daftar ↔ kassa tengligini tekshiradi:
 *   kuryer kassasi = Σ PENDING courier_amount − kuryer qoldig'i
 *   filial kassasi = Σ COURIER_SETTLED branch_amount − filial→HQ qoldig'i
 *                    + filial kuryerlari qoldig'i
 *   market kassasi = Σ faol qatorlar market_amount
 */
import { RpcException } from '@nestjs/microservices';
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
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
const BRANCH = '77';
const COURIER_ID = '289';
const MARKET_ID = '501';
const COURIER = { id: COURIER_ID, roles: ['courier'], branch_id: BRANCH };
const MANAGER = { id: '201', roles: ['manager'], branch_id: BRANCH };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

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
    find: jest.fn((o: { where?: Row; order?: Row }) =>
      Promise.resolve(
        sortRows(
          state.settlements.filter((r) => matches(r, o?.where)),
          o?.order,
        ).map(clone),
      ),
    ),
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
  let txCount = 0;
  let rolledBack = 0;
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
          txCount += 1;
          snapshot = clone(state);
          managers.set(manager, []);
        }),
        commitTransaction: jest.fn(() => {
          for (const payload of managers.get(manager) ?? []) applyCash(payload);
          managers.delete(manager);
        }),
        rollbackTransaction: jest.fn(() => {
          rolledBack += 1;
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
  const rowOf = (orderId: string) =>
    state.settlements.find((r) => r.order_id === orderId);

  /** Daftar ↔ kassa tengligi (yuqoridagi izoh). */
  const assertLedgerMatchesCash = () => {
    const active = state.settlements.filter((r) => !r.isDeleted);
    const sum = (rows: Row[], field: string) =>
      money(rows.reduce((acc, r) => acc + Number(r[field] ?? 0), 0));
    const courierPending = sum(
      active.filter(
        (r) =>
          r.status === SettlementStatus.PENDING && r.courier_id === COURIER_ID,
      ),
      'courier_amount',
    );
    expect(cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(
      money(courierPending - carry('courier_to_branch', COURIER_ID)),
    );

    const branchSettled = sum(
      active.filter(
        (r) =>
          r.status === SettlementStatus.COURIER_SETTLED &&
          r.branch_id === BRANCH,
      ),
      'branch_amount',
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
        branchSettled - carry('branch_to_hq', BRANCH) + branchCourierCarries,
      ),
    );

    const marketOwed = sum(
      active.filter(
        (r) =>
          r.market_id === MARKET_ID &&
          r.status !== SettlementStatus.MARKET_SETTLED,
      ),
      'market_amount',
    );
    expect(cash(Cashbox_type.FOR_MARKET, MARKET_ID)).toBe(marketOwed);
  };

  /** finance `payment_courier` (qabul qiluvchi — filial kassasi) + FIFO. */
  let payments = 0;
  const courierPays = async (amount: number) => {
    expect(amount).toBeLessThanOrEqual(
      cash(Cashbox_type.FOR_COURIER, COURIER_ID),
    );
    applyCash({
      cashbox_type: Cashbox_type.FOR_COURIER,
      user_id: COURIER_ID,
      amount,
      operation_type: Operation_type.EXPENSE,
    });
    applyCash({
      cashbox_type: Cashbox_type.BRANCH,
      user_id: BRANCH,
      amount,
      operation_type: Operation_type.INCOME,
    });
    payments += 1;
    return settlement.advanceSettlement({
      level: 'courier_to_branch',
      match_value: COURIER_ID,
      amount,
      requester_id: MANAGER.id,
      request_id: `pay-${payments}`,
    });
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
    lookup,
    dataSource,
    activityLog,
    cash,
    carry,
    rowOf,
    addOrder,
    courierPays,
    assertLedgerMatchesCash,
    txStats: () => ({ txCount, rolledBack }),
  };
}

// ─────────────────────────── ⭐ to'liq zanjir ───────────────────────────

describe('⭐ fix3b M6 — SA rollback → qayta sotuv → keyingi FIFO: daftar va kassalar izchil', () => {
  it.each([
    ['qo`shimcha xarajatsiz', 0],
    ['kuryer qo`shimcha xarajati bilan (5 000)', 5000],
  ])('%s', async (_label, extraCost) => {
    const w = makeWorld();
    w.addOrder('7001', 165000);

    // 1) Kuryer A ni sotadi: 165 000 − ulush 25 000 − xarajat = c_A.
    await w.svc.sellOrder(
      COURIER,
      '7001',
      { extraCost, extraCostApproved: true },
      'sell-a',
    );
    const cA = 165000 - 25000 - extraCost;
    expect(w.rowOf('7001')).toMatchObject({
      status: SettlementStatus.PENDING,
      courier_amount: cA,
    });
    w.assertLedgerMatchesCash();

    // 2) Kuryer c_A ni filialga topshiradi — qator COURIER_SETTLED.
    await w.courierPays(cA);
    expect(w.rowOf('7001')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    w.assertLedgerMatchesCash();

    // 3) Superadmin xato kiritilgan sotuvni qaytaradi.
    const res = (await w.svc.rollbackOrderToWaiting(
      SUPERADMIN,
      '7001',
      undefined,
      'rb-1',
    )) as { message: string };
    expect(res.message).toContain(
      `Kuryer filialga topshirgan ${cA} so'm uning keyingi topshirig'iga hisoblanadi`,
    );
    expect(w.state.orders['7001']).toMatchObject({
      status: Order_status.WAITING,
      sold_at: null,
      sale_collectible_amount: null,
    });
    expect(w.rowOf('7001')).toMatchObject({ isDeleted: true });
    // Topshirilgan pul yo'qolmadi — kuryer qoldig'iga kredit (filial 77).
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(cA);
    expect(
      w.state.carries.find(
        (c) => c.level === 'courier_to_branch' && c.party_id === COURIER_ID,
      )?.branch_id,
    ).toBe(BRANCH);
    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(-cA);
    expect(w.cash(Cashbox_type.BRANCH, BRANCH)).toBe(cA);
    expect(w.cash(Cashbox_type.FOR_MARKET, MARKET_ID)).toBe(0);
    w.assertLedgerMatchesCash();
    expect(w.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.rollback',
        metadata: expect.objectContaining({
          courier_credit_carried: cA,
          courier_credit_courier_id: COURIER_ID,
          courier_credit_branch_id: BRANCH,
        }),
      }),
    );

    // 4) Buyurtma (to'g'ri) qayta sotiladi — xarajatsiz: c_A' = 140 000.
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a-2');
    expect(w.rowOf('7001')).toMatchObject({
      status: SettlementStatus.PENDING,
      isDeleted: false,
      courier_amount: 140000,
    });
    w.assertLedgerMatchesCash();

    // 5) Kuryer yana B ni sotadi: 100 000 − 25 000 = 75 000.
    w.addOrder('7002', 100000);
    await w.svc.sellOrder(COURIER, '7002', {}, 'sell-b');
    w.assertLedgerMatchesCash();

    // 6) Keyingi topshiriq: kassadagi qoldiq. FIFO qoldiqni (c_A) ISTE'MOL
    //    qiladi va ikkala qatorni ham yopadi.
    const due = w.cash(Cashbox_type.FOR_COURIER, COURIER_ID);
    expect(due).toBe(140000 + 75000 - cA);
    await w.courierPays(due);

    expect(w.rowOf('7001')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(w.rowOf('7002')?.status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(0);
    // Filialda AYNAN ikki sotuvning naqdi: 140 000 + 75 000.
    expect(w.cash(Cashbox_type.BRANCH, BRANCH)).toBe(215000);
    w.assertLedgerMatchesCash();
  });

  it('nazorat: kredit YOZILMASA (eski M6 muammosi) daftar ↔ kassa tengligi BUZILADI', async () => {
    // Tekshiruvchining o'zi sezgir ekanini ko'rsatadi: qoldiqqa kredit
    // yozilmasa kuryer kassasi −140 000, daftar esa 0 ni ko'rsatadi.
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
    await w.courierPays(140000);
    (w.svc as unknown as Row).creditRemittedCourierCarry = jest
      .fn()
      .mockResolvedValue(undefined);

    await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');

    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(-140000);
    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(() => w.assertLedgerMatchesCash()).toThrow();
  });

  it('qulf tartibi: kuryer qoldig`i → filial→HQ qoldig`i → settlement qatori (runFifoSettlement bilan mos)', async () => {
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
    await w.courierPays(140000);
    w.events.length = 0;

    await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');

    expect(w.events).toEqual([
      `lock:carry:courier_to_branch:${COURIER_ID}`,
      `lock:carry:branch_to_hq:${BRANCH}`,
      'lock:settlement:7001',
    ]);
  });

  it('kuryerda shu filialdagi eski qoldiq bo`lsa kredit unga QO`SHILADI', async () => {
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
    // Ortiqcha topshiriq yo'q — sun'iy eski qoldiq (masalan oldingi to'lovdan).
    await w.courierPays(140000);
    w.state.carries.find(
      (c) => c.level === 'courier_to_branch' && c.party_id === COURIER_ID,
    )!.amount = 10000;
    w.state.cash[`${Cashbox_type.FOR_COURIER}:${COURIER_ID}`] = -10000;
    w.state.cash[`${Cashbox_type.BRANCH}:${BRANCH}`] = 150000;
    w.assertLedgerMatchesCash();

    await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');

    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(150000);
    w.assertLedgerMatchesCash();
  });
});

// ─────────────────────────── rad etiladigan holatlar ───────────────────────────

/** Sotilgan va kuryer puli topshirilgan A (COURIER_SETTLED) tayyor dunyo. */
async function remittedWorld(opts: { carryTable?: boolean } = {}) {
  const w = makeWorld(opts);
  w.addOrder('7001', 165000);
  await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');
  await w.courierPays(140000);
  expect(w.rowOf('7001')?.status).toBe(SettlementStatus.COURIER_SETTLED);
  return w;
}

const snapshotOf = (w: Awaited<ReturnType<typeof remittedWorld>>) =>
  structuredClone({
    cash: w.state.cash,
    settlements: w.state.settlements,
    carries: w.state.carries,
    order: w.state.orders['7001'],
  });

describe('fix3b M6 — kuryer/menejer avvalgidek yopiq', () => {
  it.each([
    ['kuryer', COURIER],
    ['menejer', MANAGER],
  ])('⭐ %s — 400, hech narsa o`zgarmaydi', async (_label, requester) => {
    const w = await remittedWorld();
    const before = snapshotOf(w);

    const error = await rpcError(
      w.svc.rollbackOrderToWaiting(requester, '7001'),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("topshirib bo'lgan");
    expect(error.message).toContain('faqat superadmin');
    expect(snapshotOf(w)).toEqual(before);
  });
});

describe('fix3b M6 — superadmin uchun ham xavfsiz bo`lmagan holatlar rad etiladi', () => {
  const expectUnchanged = async (
    w: Awaited<ReturnType<typeof remittedWorld>>,
    status: number,
    text: string,
  ) => {
    const before = snapshotOf(w);
    const error = await rpcError(
      w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-x'),
    );
    expect(error.statusCode).toBe(status);
    expect(error.message).toContain(text);
    expect(snapshotOf(w)).toEqual(before);
  };

  it('⭐ HQ`ga yetgan qator (BRANCH_SETTLED) — hamma uchun yopiq (o`zgarmagan)', async () => {
    const w = await remittedWorld();
    w.rowOf('7001')!.status = SettlementStatus.BRANCH_SETTLED;

    await expectUnchanged(w, 400, "bosh ofisga to'langan");
  });

  it('manfiy (kredit) COURIER_SETTLED qator — qoldiq manfiy bo`la olmaydi', async () => {
    const w = await remittedWorld();
    w.rowOf('7001')!.courier_amount = -4000;

    await expectUnchanged(w, 400, 'manfiy (kredit)');
  });

  it('qator filialsiz — 400', async () => {
    const w = await remittedWorld();
    w.rowOf('7001')!.branch_id = null;

    await expectUnchanged(w, 400, 'filialsiz');
  });

  it('qator HQ filialiga yozilgan — 400', async () => {
    const w = await remittedWorld();
    w.rowOf('7001')!.branch_id = HQ_ID;

    await expectUnchanged(w, 400, 'HQ filialiga');
  });

  it('HQ aniqlanmasa — 503', async () => {
    const w = await remittedWorld();
    w.lookup.getHqBranchId.mockResolvedValue(null);

    await expectUnchanged(w, 503, 'Bosh ofis');
  });

  it('qoldiq jadvali yo`q — 400 (kredit yozib bo`lmaydi)', async () => {
    const w = await remittedWorld();
    w.dataSource.query.mockResolvedValue([{ t: null }]);

    await expectUnchanged(w, 400, 'qoldig');
  });

  it('⭐ kuryer boshqa filialga o`tgan — 400 (kredit boshqa filialda sarflanib ketardi)', async () => {
    const w = await remittedWorld();
    w.lookup.getBranchAssignmentByUserStrict.mockResolvedValue({
      branch_id: '78',
      role: 'COURIER',
    });

    await expectUnchanged(w, 400, 'boshqa filialda');
  });

  it('kuryer filialini o`qib bo`lmasa — 503', async () => {
    const w = await remittedWorld();
    w.lookup.getBranchAssignmentByUserStrict.mockRejectedValue(
      new Error('timeout'),
    );

    await expectUnchanged(w, 503, 'Kuryer filialini');
  });

  it('⭐ snapshot qatorga mos kelmasa (kassa qaytimi ≠ courier_amount) — 400', async () => {
    const w = await remittedWorld();
    w.state.orders['7001'].sale_collectible_amount = 150000;

    await expectUnchanged(w, 400, 'mos kelmaydi');
  });

  it('⭐ tranzaksiya ichida qator HQ`ga yetib bo`lgan (parallel filial → HQ FIFO) — 400, tranzaksiya qaytadi', async () => {
    const w = await remittedWorld();
    // Tashqi (oldindan) o'qish COURIER_SETTLED ni ko'radi…
    const preRead = structuredClone(w.rowOf('7001'));
    (w.svc as unknown as Row).orderSettlementRepo = {
      findOne: jest.fn().mockResolvedValue(preRead),
    };
    // …lekin qulf ostida qator allaqachon BRANCH_SETTLED.
    w.rowOf('7001')!.status = SettlementStatus.BRANCH_SETTLED;
    const before = snapshotOf(w);

    const error = await rpcError(
      w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-race'),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("bosh ofisga to'langan");
    expect(w.txStats().rolledBack).toBeGreaterThan(0);
    expect(snapshotOf(w)).toEqual(before);
  });

  it('tranzaksiya ichida qator summasi o`zgargan — 400 "holati o`zgargan"', async () => {
    const w = await remittedWorld();
    const preRead = structuredClone(w.rowOf('7001'));
    (w.svc as unknown as Row).orderSettlementRepo = {
      findOne: jest.fn().mockResolvedValue(preRead),
    };
    w.rowOf('7001')!.courier_amount = 120000;
    const before = snapshotOf(w);

    const error = await rpcError(
      w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-race2'),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("o'zgargan");
    expect(snapshotOf(w)).toEqual(before);
  });

  it('kuryerda BOSHQA filialga tegishli musbat qoldiq bo`lsa — 400, tranzaksiya qaytadi', async () => {
    const w = await remittedWorld();
    const courierCarry = w.state.carries.find(
      (c) => c.level === 'courier_to_branch' && c.party_id === COURIER_ID,
    )!;
    courierCarry.amount = 5000;
    courierCarry.branch_id = '78';

    await expectUnchanged(w, 400, 'boshqa filialga tegishli qoldiq');
  });
});

describe('fix3b M6 — PENDING va nol qatorlar avvalgidek', () => {
  it('superadmin PENDING kuryer sotuvini qaytaradi — qoldiq TEGILMAYDI', async () => {
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');

    await w.svc.rollbackOrderToWaiting(SUPERADMIN, '7001', undefined, 'rb-1');

    expect(w.carry('courier_to_branch', COURIER_ID)).toBe(0);
    expect(w.cash(Cashbox_type.FOR_COURIER, COURIER_ID)).toBe(0);
    expect(w.lookup.getBranchAssignmentByUserStrict).not.toHaveBeenCalled();
    w.assertLedgerMatchesCash();
  });

  it('kuryer o`zi PENDING sotuvini qaytaradi — avvalgidek', async () => {
    const w = makeWorld();
    w.addOrder('7001', 165000);
    await w.svc.sellOrder(COURIER, '7001', {}, 'sell-a');

    await expect(
      w.svc.rollbackOrderToWaiting(COURIER, '7001', undefined, 'rb-1'),
    ).resolves.toMatchObject({
      statusCode: 200,
      message: 'Order WAITING holatiga qaytarildi',
    });
    w.assertLedgerMatchesCash();
  });
});
