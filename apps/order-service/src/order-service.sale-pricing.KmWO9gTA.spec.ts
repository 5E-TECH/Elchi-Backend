/**
 * KmWO9gTA — yetkazish narxi dvigatelini SOTUV OQIMIGA ulash.
 *
 * Karta: 7 chaqiruv joyi (rollback market/kuryer, sellOrder market/kuryer,
 * markByProvider, partlySellOrder market/kuryer) + sotuvdan oldingi chegara
 * (`computeSaleMarketPaidMax`, uguUEhin) — har biri ESKI va YANGI narxni AYNI
 * kirish bilan solishtirib sinaladi:
 *
 *   • dvigatel o'chiq (`SALE_PRICING_ENGINE` sukuti) yoki marketning
 *     `weight_volume_pricing` = FALSE — pul oyoqlari, settlement va snapshot
 *     BAYTMA-BAYT avvalgidek (ega qarori 2026-10-19 regressiya talabi);
 *   • dvigatel yoqiq — market tarifi = standart narx + vazn/hajm qo'shimchasi,
 *     floor (DARVOZA 1), qo'shimcha xarajat chegarasi jadvaldan (DARVOZA 2);
 *   • snapshot bor buyurtmada narx O'ZGARMAYDI, rollback dvigatelni chaqirmaydi
 *     va kassada qoldiq qolmaydi (BeePost B5 saboqi);
 *   • kuryer tarifi TEGILMAYDI.
 *
 * Uslub: `Object.create(prototype)` + stub (fix3-rollback-money.spec kabi).
 * Pul mantig'i (`sellOrder`, `partlySellOrder`, `markByProvider`,
 * `rollbackOrderToWaiting`, `recordSaleSettlement`) HAQIQIY.
 */
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  resolvePartnerMoneyFields,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import {
  computeSaleLegs,
  computeSaleMarketPaidMax,
  computeSellProfit,
  computeSellExtraCostLimit,
  resolveOrderTariff,
  resolveOrderTariffDetailed,
} from './domain/order-money';
import {
  buildSaleQuoteItems,
  buildSaleQuotePayload,
  isSalePricingEngineActive,
  readSalePricingConfig,
  SALE_QUOTE_PATTERN,
} from './pricing/sale-pricing';

type Row = Record<string, any>;
type Leg = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;

const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

const ENV_KEYS = ['SALE_PRICING_ENGINE', 'SALE_PRICING_ENGINE_MARKET_IDS'];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
const engineOn = (marketIds?: string) => {
  process.env.SALE_PRICING_ENGINE = 'on';
  if (marketIds !== undefined) {
    process.env.SALE_PRICING_ENGINE_MARKET_IDS = marketIds;
  }
};

/** ESKI `resolveOrderTariff` — KmWO9gTA dan oldingi kod, so'zma-so'z. */
function legacyResolveOrderTariff(params: {
  snapshot: number | null | undefined;
  isCenter: boolean;
  centerTariff: number | null | undefined;
  homeTariff: number | null | undefined;
}): number {
  if (params.snapshot != null) {
    return Number(params.snapshot);
  }
  return Number(
    (params.isCenter ? params.centerTariff : params.homeTariff) ?? 0,
  );
}

/** ESKI `assertExtraCostWithinLimit` sotuv chegarasi — so'zma-so'z. */
function legacySellExtraCostMax(tariffCenter: number, tariffHome: number) {
  const center = Math.max(0, Number(tariffCenter) || 0);
  const home = Math.max(0, Number(tariffHome) || 0);
  const diff = home - center;
  return diff > 0 ? Math.floor(diff) : Math.floor(center / 2);
}

/** Logistics `sale_quote` javobi: 2.4 kg, center, kg narxi 4 000 → +8 000. */
const QUOTE = (over: Row = {}): Row => ({
  tariff_id: 'center',
  tariff_row_id: '2',
  base_price: 40000,
  extra_per_kg: 4000,
  extra: 8000,
  extraKg: 2,
  billableKg: 2.4,
  actualKg: 2.4,
  volumetricKg: 1.2,
  basis: 'weight',
  estimated: false,
  unmeasuredItems: 0,
  missingDimensionItems: 0,
  settings_id: '1',
  min_delivery_price: null,
  extra_cost_limit_amount: null,
  center_base: 40000,
  address_base: 60000,
  ...over,
});

const MARKET: Row = {
  id: '501',
  tariff_center: 45000,
  tariff_home: 70000,
  expense_proof_conditions: [],
  region_id: '1',
  district_id: null,
  weight_volume_pricing: true,
};
const COURIER_ROW: Row = {
  id: '289',
  tariff_center: 30000,
  tariff_home: 50000,
  can_add_extra_cost: true,
  can_sell_cancel: true,
};
const ITEMS: Row[] = [
  {
    id: '1',
    order_id: '7001',
    product_id: '4',
    product_name: null,
    quantity: 2,
  },
  {
    id: '2',
    order_id: '7001',
    product_id: '5',
    product_name: null,
    quantity: 1,
  },
];
const WAITING_ORDER: Row = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 250000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  region_id: '12',
  district_id: '120',
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
  sold_at: null,
  market_tariff: null,
  courier_tariff: null,
  extra_cost: 0,
  items: ITEMS,
};

interface WorldOpts {
  order?: Row;
  market?: Row | null;
  courier?: Row;
  quote?: Row | Error;
  branchShare?: number;
}

/** Sotuv / qisman sotuv / bekor qilish uchun dunyo (fix3 makeSellService). */
function makeSaleWorld(opts: WorldOpts = {}) {
  const order: Row = {
    ...WAITING_ORDER,
    items: ITEMS.map((item) => ({ ...item })),
    ...(opts.order ?? {}),
  };
  const market =
    opts.market === null ? undefined : { ...MARKET, ...(opts.market ?? {}) };
  const legs: Leg[] = [];
  const updates: Row[] = [];
  const settlements: Row[] = [];
  const children: Row[] = [];
  const logs: Row[] = [];
  const rpc: Array<{ cmd: string; payload: Row }> = [];

  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlements.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderSettlement) return settlementRepo;
      if (entity === OrderItem) {
        return {
          save: jest.fn((row: Row) => Promise.resolve(row)),
          createQueryBuilder: () => ({
            insert: () => ({
              values: () => ({ execute: () => Promise.resolve({}) }),
            }),
          }),
        };
      }
      if (entity === Order) {
        return {
          create: (value: Row) => value,
          save: (value: Row) => {
            children.push(value);
            return Promise.resolve({ id: '9900', ...value });
          },
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
      }
      return {};
    }),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: tx,
  };

  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn((pattern: { cmd: string }, payload: Row) => {
        rpc.push({ cmd: pattern.cmd, payload });
        if (pattern.cmd === SALE_QUOTE_PATTERN) {
          if (opts.quote instanceof Error) {
            const error = opts.quote;
            return throwError(() => error);
          }
          return of({ data: opts.quote ?? QUOTE() });
        }
        return of({ data: { id: '9001', courier_id: '289' } });
      }),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: {
      log: jest.fn((entry: Row) => {
        logs.push(entry);
        return Promise.resolve();
      }),
    },
    custody: {
      auditActor: jest.fn(() => ({})),
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'courier'),
    },
    // Har chaqiruvda yangi nusxa: qisman sotuv qatorlar sonini joyida
    // kamaytiradi (umumiy ITEMS buzilmasin).
    orderItemRepo: {
      find: jest.fn(() => Promise.resolve(ITEMS.map((item) => ({ ...item })))),
    },
    lookup: {
      getMarketsByIds: jest.fn(() => Promise.resolve(market ? [market] : [])),
      getCouriersByIds: jest.fn(() =>
        Promise.resolve([{ ...COURIER_ROW, ...(opts.courier ?? {}) }]),
      ),
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(opts.branchShare ?? 0),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn(() => Promise.resolve({ ...order })),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    resolveHolderFromState: jest.fn().mockResolvedValue({
      holder_type: 'COURIER',
      holder_branch_id: '77',
      holder_courier_id: '289',
    }),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Leg) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });

  const quoteCalls = () => rpc.filter((c) => c.cmd === SALE_QUOTE_PATTERN);
  return { s, order, legs, updates, settlements, children, logs, quoteCalls };
}

/** Rollback dunyosi (fix3 makeRollbackService). */
function makeRollbackWorld(order: Row, settlement: Row, market: Row = MARKET) {
  const legs: Leg[] = [];
  const updates: Row[] = [];
  const resets: string[] = [];
  const rpc: string[] = [];
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? { findOne: jest.fn().mockResolvedValue({ ...order }) }
          : {},
      ),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    orderSettlementRepo: { findOne: jest.fn().mockResolvedValue(settlement) },
    logisticsClient: {
      send: jest.fn((pattern: { cmd: string }) => {
        rpc.push(pattern.cmd);
        return of({ data: { id: '9001', courier_id: '289' } });
      }),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([market]),
      getCouriersByIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ ...COURIER_ROW, id }))),
      ),
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn().mockResolvedValue(order),
    updateCashboxBalance: jest.fn((leg: Leg) => {
      legs.push(leg);
      return Promise.resolve();
    }),
    resetSettlementOnRollback: jest.fn((_tx: unknown, id: string) => {
      resets.push(id);
      return Promise.resolve();
    }),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  return { s, legs, updates, resets, rpc };
}

/** Kargo (markByProvider) dunyosi (fix3b makeProviderHarness). */
function makeProviderWorld(opts: { market?: Row; quote?: Row } = {}) {
  const order: Row = {
    ...WAITING_ORDER,
    id: '8001',
    total_price: 200000,
    branch_id: '22',
    holder_branch_id: '22',
  };
  const saved: Row[] = [];
  const legs: Leg[] = [];
  const settlements: Row[] = [];
  const rpc: string[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlements.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Order) {
          return {
            save: jest.fn((value: Row) => {
              saved.push({ ...value });
              return Promise.resolve(value);
            }),
          };
        }
        if (entity === OrderSettlement) return settlementRepo;
        return {};
      }),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn((pattern: { cmd: string }) => {
        rpc.push(pattern.cmd);
        return of({ data: opts.quote ?? QUOTE() });
      }),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      auditActor: jest.fn(() => ({})),
    },
    lookup: {
      getMarketsByIds: jest
        .fn()
        .mockResolvedValue([{ ...MARKET, ...(opts.market ?? {}) }]),
    },
    findById: jest.fn(() => Promise.resolve({ ...order })),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Leg) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });
  return { s, saved, legs, settlements, rpc };
}

/** Kassa oyoqlarining ma'noli qismi. */
const shape = (legs: Leg[]) =>
  legs.map((leg) => ({
    user_id: leg.user_id,
    cashbox_type: leg.cashbox_type,
    amount: leg.amount,
    operation_type: leg.operation_type,
    source_type: leg.source_type,
  }));

/** Sotuv natijasi — vaqtga bog'liq maydonlarsiz (sold_at, dedup). */
const saleResult = (w: ReturnType<typeof makeSaleWorld>) => ({
  legs: shape(w.legs),
  update: { ...w.updates[0], sold_at: undefined },
  settlements: w.settlements,
});

const net = (legs: Leg[]) => {
  const sums = new Map<string, number>();
  for (const leg of legs) {
    const key = `${String(leg.cashbox_type)}:${String(leg.user_id)}`;
    const sign = leg.operation_type === Operation_type.INCOME ? 1 : -1;
    sums.set(key, (sums.get(key) ?? 0) + sign * Number(leg.amount));
  }
  return sums;
};

async function rpcError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

// ===========================================================================
describe('KmWO9gTA — resolveOrderTariff (sof): eski va yangi', () => {
  it('dvigatelsiz — eski formula bilan BAYTMA-BAYT (matritsa)', () => {
    const snapshots = [null, undefined, 0, 25000, 33333.33];
    const centers = [null, undefined, 0, 45000];
    const homes = [null, undefined, 70000];
    let checked = 0;
    const cases = snapshots.flatMap((snapshot) =>
      [true, false].flatMap((isCenter) =>
        centers.flatMap((centerTariff) =>
          homes.map((homeTariff) => ({
            snapshot,
            isCenter,
            centerTariff,
            homeTariff,
          })),
        ),
      ),
    );
    for (const params of cases) {
      expect(resolveOrderTariff(params)).toBe(legacyResolveOrderTariff(params));
      // engine: null — ham eski xulq.
      expect(resolveOrderTariff({ ...params, engine: null })).toBe(
        legacyResolveOrderTariff(params),
      );
      checked += 1;
    }
    expect(checked).toBe(5 * 2 * 4 * 3);
  });

  it('TC2: snapshot bor — dvigatel natijasi e`tiborsiz, snapshot ustun', () => {
    const r = resolveOrderTariffDetailed({
      snapshot: 33000,
      isCenter: true,
      centerTariff: 45000,
      homeTariff: 70000,
      engine: { surcharge: 99000, tableBase: 40000, minDeliveryPrice: 90000 },
      sharesFloor: 80000,
    });
    expect(r).toMatchObject({ tariff: 33000, source: 'snapshot' });
  });

  it('dvigatel: standart narx (profil) + vazn/hajm qo`shimchasi', () => {
    const r = resolveOrderTariffDetailed({
      snapshot: null,
      isCenter: true,
      centerTariff: 45000,
      homeTariff: 70000,
      engine: { surcharge: 8000, tableBase: 40000 },
      sharesFloor: 30000,
    });
    expect(r).toMatchObject({
      tariff: 53000,
      source: 'engine',
      standard: 45000,
      base: 45000,
      surcharge: 8000,
      floorApplied: false,
    });
    // Uyga: standart uy narxi.
    expect(
      resolveOrderTariff({
        snapshot: null,
        isCenter: false,
        centerTariff: 45000,
        homeTariff: 70000,
        engine: { surcharge: 8000, tableBase: 60000 },
      }),
    ).toBe(78000);
  });

  it('profil tarifi yo`q (legacy, NULL) — baza tarif jadvalidan; 0 esa 0 (bepul kelishuv)', () => {
    const params = {
      snapshot: null,
      isCenter: true,
      homeTariff: null,
      engine: { surcharge: 4000, tableBase: 40000 },
    };
    expect(resolveOrderTariff({ ...params, centerTariff: null })).toBe(44000);
    expect(resolveOrderTariff({ ...params, centerTariff: 0 })).toBe(4000);
  });

  it('DARVOZA 1 floor: kuryer + filial ulushi va min_delivery_price', () => {
    const base = {
      snapshot: null,
      isCenter: true,
      centerTariff: 10000,
      homeTariff: 20000,
    };
    expect(
      resolveOrderTariffDetailed({
        ...base,
        engine: { surcharge: 0, tableBase: 40000 },
        sharesFloor: 30000 + 3000,
      }),
    ).toMatchObject({ tariff: 33000, computed: 10000, floorApplied: true });
    expect(
      resolveOrderTariffDetailed({
        ...base,
        engine: { surcharge: 0, tableBase: 40000, minDeliveryPrice: 35000 },
        sharesFloor: 30000,
      }),
    ).toMatchObject({ tariff: 35000, floor: 35000, floorApplied: true });
    // Dvigatelsiz floor YO'Q — eski xulq (DARVOZA 1 rad etadi).
    expect(resolveOrderTariff({ ...base, sharesFloor: 30000 })).toBe(10000);
  });

  it('TC4: saqlanish identiteti dvigatel narxi bilan ham (matritsa)', () => {
    const grid = [0, 1000, 150000, 250000.5].flatMap((total) =>
      [0, 4000, 56000].flatMap((surcharge) =>
        [0, 25000, 30000].flatMap((courierShare) =>
          [0, 3000].map((branchShare) => ({
            total,
            surcharge,
            courierShare,
            branchShare,
          })),
        ),
      ),
    );
    for (const { total, surcharge, courierShare, branchShare } of grid) {
      {
        const tariff = resolveOrderTariff({
          snapshot: null,
          isCenter: true,
          centerTariff: 20000,
          homeTariff: 40000,
          engine: { surcharge, tableBase: 40000 },
          sharesFloor: courierShare + branchShare,
        });
        const legs = computeSaleLegs({
          total,
          marketTariff: tariff,
          courierShare,
          branchShare,
        });
        const sum =
          Math.round(
            (legs.marketReceivable +
              legs.courierKept +
              legs.branchKept +
              legs.hqProfit) *
              100,
          ) / 100;
        expect(sum).toBe(total);
        // Floor tufayli HQ hech qachon zarar ko'rmaydi.
        expect(legs.hqProfit).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('KmWO9gTA — DARVOZA 2 (computeSellExtraCostLimit)', () => {
  it('legacy rejim — eski formula bilan aynan (matritsa)', () => {
    const pairs = [0, 15000, 30000, 30000.7].flatMap((center) =>
      [0, 30000, 50000, 45000.9].map((home) => ({ center, home })),
    );
    for (const { center, home } of pairs) {
      {
        expect(
          computeSellExtraCostLimit({
            mode: 'legacy',
            tariffCenter: center,
            tariffHome: home,
          }).max,
        ).toBe(legacySellExtraCostMax(center, home));
      }
    }
  });

  it('dvigatel rejimi — tariff_home−tariff_center ga TAYANMAYDI', () => {
    expect(
      computeSellExtraCostLimit({
        mode: 'engine',
        limitAmount: null,
        centerBase: 40000,
        addressBase: 60000,
      }).max,
    ).toBe(20000);
    expect(
      computeSellExtraCostLimit({
        mode: 'engine',
        limitAmount: null,
        centerBase: 40000,
        addressBase: 40000,
      }).max,
    ).toBe(20000);
    expect(
      computeSellExtraCostLimit({
        mode: 'engine',
        limitAmount: 7500.5,
        centerBase: 40000,
        addressBase: 60000,
      }).max,
    ).toBe(7500);
  });
});

describe('KmWO9gTA — sotuvdan oldingi chegara (computeSaleMarketPaidMax)', () => {
  it('dvigatelsiz — avvalgidek; dvigatel bilan — sotuvdagi AYNI narx', () => {
    const base = {
      totalPrice: 250000,
      paidOnlineAmount: 0,
      paidAmount: 0,
      marketTariffSnapshot: null,
      isCenter: true,
      centerTariff: 45000,
      homeTariff: 70000,
    };
    expect(computeSaleMarketPaidMax(base)).toBe(205000);
    expect(computeSaleMarketPaidMax({ ...base, engine: null })).toBe(205000);
    expect(
      computeSaleMarketPaidMax({
        ...base,
        engine: { surcharge: 8000, tableBase: 40000 },
      }),
    ).toBe(197000);
    // Snapshot bor — dvigatel e'tiborsiz.
    expect(
      computeSaleMarketPaidMax({
        ...base,
        marketTariffSnapshot: 30000,
        engine: { surcharge: 8000, tableBase: 40000 },
      }),
    ).toBe(220000);
    // Profil tarifi yo'q: avval null, dvigatel bilan — jadval bazasi.
    expect(
      computeSaleMarketPaidMax({ ...base, centerTariff: null }),
    ).toBeNull();
    expect(
      computeSaleMarketPaidMax({
        ...base,
        centerTariff: null,
        engine: { surcharge: 8000, tableBase: 40000 },
      }),
    ).toBe(202000);
  });
});

describe('KmWO9gTA — darvozalar sozlamasi (sale-pricing)', () => {
  it('sukut — o`chiq; faqat `on` yoqadi; canary ro`yxati', () => {
    expect(readSalePricingConfig({})).toEqual({
      enabled: false,
      marketIds: null,
    });
    expect(readSalePricingConfig({ SALE_PRICING_ENGINE: 'true' }).enabled).toBe(
      false,
    );
    const cfg = readSalePricingConfig({
      SALE_PRICING_ENGINE: ' ON ',
      SALE_PRICING_ENGINE_MARKET_IDS: '37, 501,abc',
    });
    expect(cfg.enabled).toBe(true);
    expect([...(cfg.marketIds ?? [])]).toEqual(['37', '501']);
    expect(isSalePricingEngineActive(cfg, '501', {})).toBe(true);
    expect(isSalePricingEngineActive(cfg, '502', {})).toBe(false);
    expect(
      isSalePricingEngineActive(cfg, '501', { weight_volume_pricing: false }),
    ).toBe(false);
    expect(
      isSalePricingEngineActive(readSalePricingConfig({}), '501', {}),
    ).toBe(false);
  });

  it('elementlar — bitta jo`natma: mahsulot bo`yicha qo`shiladi, katalogsizi o`lchovsiz', () => {
    expect(
      buildSaleQuoteItems([
        { product_id: '4', quantity: 2 },
        { product_id: '4', quantity: 1 },
        { product_id: null, quantity: 3 },
        { product_id: '5', quantity: 0 },
      ]),
    ).toEqual([
      { product_id: '4', quantity: 3 },
      { product_id: null, quantity: 3 },
    ]);
    expect(
      buildSaleQuotePayload(
        {
          where_deliver: Where_deliver.ADDRESS,
          region_id: '12',
          district_id: null,
          items: [],
        },
        { region_id: null, district_id: '7' },
      ),
    ).toEqual({
      where_deliver: 'address',
      from_region_id: null,
      from_district_id: '7',
      to_region_id: '12',
      to_district_id: null,
      items: [],
    });
  });
});

// ===========================================================================
describe('KmWO9gTA — sellOrder (market :6388, kuryer :6394)', () => {
  it('⭐ eski va yangi AYNI kirish: dvigatel o`chiq == bayroq FALSE — baytma-bayt', async () => {
    const off = makeSaleWorld();
    await off.s.sellOrder(COURIER, '7001', {});

    engineOn();
    const flagOff = makeSaleWorld({ market: { weight_volume_pricing: false } });
    await flagOff.s.sellOrder(COURIER, '7001', {});

    expect(off.quoteCalls()).toHaveLength(0);
    expect(flagOff.quoteCalls()).toHaveLength(0);
    expect(saleResult(flagOff)).toEqual(saleResult(off));
    expect(off.updates[0]).toMatchObject({
      market_tariff: 45000,
      courier_tariff: 30000,
      courier_share: 30000,
      to_be_paid: 205000,
    });
    // Jurnal shakli ham avvalgidek (sale_pricing yo'q).
    const sell = off.logs.find((l) => l.action === 'order.sell');
    expect(sell?.metadata).not.toHaveProperty('sale_pricing');
  });

  it('⭐ TC3: dvigatel yoqiq — market_tariff hisoblangan, naqd to`g`ri, kuryer tegilmagan', async () => {
    const off = makeSaleWorld();
    await off.s.sellOrder(COURIER, '7001', {});

    engineOn();
    const on = makeSaleWorld();
    await on.s.sellOrder(COURIER, '7001', {});

    expect(on.quoteCalls()).toHaveLength(1);
    expect(on.quoteCalls()[0].payload).toMatchObject({
      where_deliver: 'center',
      from_region_id: '1',
      to_region_id: '12',
      to_district_id: '120',
      items: [
        { product_id: '4', quantity: 2 },
        { product_id: '5', quantity: 1 },
      ],
    });
    expect(on.updates[0]).toMatchObject({
      market_tariff: 53000,
      to_be_paid: 197000,
      // TC10: kuryer tarifi va ulushi dvigatelsiz holat bilan AYNI.
      courier_tariff: off.updates[0].courier_tariff,
      courier_share: off.updates[0].courier_share,
      sale_collectible_amount: 250000,
    });
    // Market oyog'i: yig'ilgan − tarif.
    const marketLeg = on.legs.find(
      (l) => l.cashbox_type === Cashbox_type.FOR_MARKET,
    );
    expect(marketLeg).toMatchObject({
      amount: 197000,
      operation_type: Operation_type.INCOME,
    });
    // Kuryer oyog'i o'zgarmagan.
    expect(
      shape(on.legs).filter((l) => l.cashbox_type === Cashbox_type.FOR_COURIER),
    ).toEqual(
      shape(off.legs).filter(
        (l) => l.cashbox_type === Cashbox_type.FOR_COURIER,
      ),
    );
    // Settlement bitta, market_amount = kassa oyog'i.
    expect(on.settlements).toHaveLength(1);
    expect(on.settlements[0]).toMatchObject({ market_amount: 197000 });
    // Jurnal: narx qayerdan chiqdi.
    const sell = on.logs.find((l) => l.action === 'order.sell');
    expect(sell?.metadata?.sale_pricing).toMatchObject({
      source: 'engine',
      market_tariff: 53000,
      standard_price: 45000,
      surcharge: 8000,
      billable_kg: 2.4,
      tariff_id: 'center',
    });
    // TC11: hamkor elchi_fee = yangi market_tariff; sotuvdan oldin NULL.
    expect(resolvePartnerMoneyFields(on.order).elchi_fee).toBeNull();
    expect(
      resolvePartnerMoneyFields({ ...on.order, ...on.updates[0] }).elchi_fee,
    ).toBe(53000);
  });

  it('TC2: snapshot bor — dvigatel chaqirilmaydi, narx o`zgarmaydi', async () => {
    engineOn();
    const w = makeSaleWorld({ order: { market_tariff: 33000 } });
    await w.s.sellOrder(COURIER, '7001', {});
    expect(w.quoteCalls()).toHaveLength(0);
    expect(w.updates[0]).toMatchObject({ market_tariff: 33000 });
  });

  it('canary: market ro`yxatda bo`lmasa — eski narx', async () => {
    engineOn('37');
    const w = makeSaleWorld();
    await w.s.sellOrder(COURIER, '7001', {});
    expect(w.quoteCalls()).toHaveLength(0);
    expect(w.updates[0]).toMatchObject({ market_tariff: 45000 });
  });

  it('dvigatel javob bermasa — standart narx, sotuv TO`XTAMAYDI, jurnalda sabab', async () => {
    engineOn();
    const w = makeSaleWorld({
      quote: new RpcException({ statusCode: 409, message: 'tarif yo`q' }),
    });
    await w.s.sellOrder(COURIER, '7001', {});
    expect(w.updates[0]).toMatchObject({ market_tariff: 45000 });
    const sell = w.logs.find((l) => l.action === 'order.sell');
    expect(sell?.metadata?.sale_pricing).toMatchObject({
      source: 'profile',
      engine_error: 'tarif yo`q',
    });
  });

  it('⭐ TC5 DARVOZA 1: kichik posilka — eski yo`l 400, dvigatel floor bilan sotadi', async () => {
    const small = { market: { tariff_center: 10000, tariff_home: 20000 } };
    const off = makeSaleWorld(small);
    const err = await rpcError(off.s.sellOrder(COURIER, '7001', {}));
    expect(err.statusCode).toBe(400);
    expect(off.legs).toHaveLength(0);

    engineOn();
    const on = makeSaleWorld({
      ...small,
      quote: QUOTE({ extra: 0, extraKg: 0, billableKg: 0.4 }),
      branchShare: 3000,
    });
    await on.s.sellOrder(COURIER, '7001', {});
    expect(on.updates[0]).toMatchObject({
      market_tariff: 33000,
      courier_share: 30000,
      branch_share: 3000,
    });
    const legs = computeSaleLegs({
      total: 250000,
      marketTariff: 33000,
      courierShare: 30000,
      branchShare: 3000,
    });
    expect(legs.hqProfit).toBe(0);
    const sell = on.logs.find((l) => l.action === 'order.sell');
    expect(sell?.metadata?.sale_pricing).toMatchObject({
      floor_applied: true,
      computed: 10000,
      floor: 33000,
    });
  });

  it('⭐ TC6 DARVOZA 2: dvigatel narxida chegara jadvaldan, kuryer tarif farqidan emas', async () => {
    // Kuryer tariflari teng — eski chegara 15 000 (markazning 50%i).
    const courier = { tariff_center: 30000, tariff_home: 30000 };
    const off = makeSaleWorld({ courier });
    const offErr = await rpcError(
      off.s.sellOrder(COURIER, '7001', {
        extraCost: 18000,
        extraCostApproved: true,
      }),
    );
    expect(offErr.message).toContain('15000');

    engineOn();
    const ok = makeSaleWorld({ courier });
    await ok.s.sellOrder(COURIER, '7001', {
      extraCost: 18000,
      extraCostApproved: true,
    });
    expect(ok.updates[0]).toMatchObject({ extra_cost: 18000 });

    const tooMuch = makeSaleWorld({ courier });
    const err = await rpcError(
      tooMuch.s.sellOrder(COURIER, '7001', {
        extraCost: 21000,
        extraCostApproved: true,
      }),
    );
    expect(err.message).toContain('20000');
    expect(err.message).toContain('tarif jadvali');

    const amount = makeSaleWorld({
      courier,
      quote: QUOTE({ extra_cost_limit_amount: 5000 }),
    });
    const amountErr = await rpcError(
      amount.s.sellOrder(COURIER, '7001', {
        extraCost: 6000,
        extraCostApproved: true,
      }),
    );
    expect(amountErr.message).toContain('5000');
  });

  it('TC15: ochilgandagi narx bilan sotuvdagi farq JURNALGA yoziladi', async () => {
    engineOn();
    const w = makeSaleWorld({ order: { quoted_market_tariff: 45000 } });
    await w.s.sellOrder(COURIER, '7001', {});
    const drift = w.logs.find(
      (l) => l.action === 'order.delivery_price_changed',
    );
    expect(drift).toMatchObject({
      old_value: { market_tariff: 45000 },
      new_value: { market_tariff: 53000 },
      metadata: { path: 'sell', difference: 8000 },
    });

    const same = makeSaleWorld({ order: { quoted_market_tariff: 53000 } });
    await same.s.sellOrder(COURIER, '7001', {});
    expect(
      same.logs.some((l) => l.action === 'order.delivery_price_changed'),
    ).toBe(false);
  });
});

describe('KmWO9gTA — partlySellOrder (market :7825, kuryer :7831)', () => {
  const partly = {
    order_item_info: [
      { product_id: '4', quantity: 1 },
      { product_id: '5', quantity: 1 },
    ],
    totalPrice: 150000,
  };

  it('⭐ eski va yangi AYNI kirish: dvigatel o`chiq == bayroq FALSE', async () => {
    const off = makeSaleWorld();
    await off.s.partlySellOrder(COURIER, '7001', partly);
    engineOn();
    const flagOff = makeSaleWorld({ market: { weight_volume_pricing: false } });
    await flagOff.s.partlySellOrder(COURIER, '7001', partly);
    expect(flagOff.quoteCalls()).toHaveLength(0);
    expect(saleResult(flagOff)).toEqual(saleResult(off));
    expect(off.updates[0]).toMatchObject({ market_tariff: 45000 });
  });

  it('⭐ TC7: ota va bola summalari to`g`ri, dvigatelga BUTUN posilka, settlement bitta', async () => {
    engineOn();
    const w = makeSaleWorld();
    await w.s.partlySellOrder(COURIER, '7001', partly);

    expect(w.quoteCalls()).toHaveLength(1);
    expect(w.quoteCalls()[0].payload.items).toEqual([
      { product_id: '4', quantity: 2 },
      { product_id: '5', quantity: 1 },
    ]);
    expect(w.updates[0]).toMatchObject({
      total_price: 150000,
      market_tariff: 53000,
      to_be_paid: 97000,
      courier_tariff: 30000,
    });
    expect(w.settlements).toHaveLength(1);
    expect(w.settlements[0]).toMatchObject({ market_amount: 97000 });
    // Bola (bekor qilingan qism): 100 000, tarif yo'q, qarz yo'q.
    expect(w.children).toHaveLength(1);
    expect(w.children[0]).toMatchObject({
      total_price: 100000,
      to_be_paid: 0,
      status: Order_status.CANCELLED,
    });
    expect(w.children[0].market_tariff ?? null).toBeNull();
    const log = w.logs.find((l) => l.action === 'order.partly_sell');
    expect(log?.metadata?.sale_pricing).toMatchObject({ source: 'engine' });
  });
});

describe('KmWO9gTA — markByProvider (:7510)', () => {
  it('⭐ eski va yangi: o`chiq == bayroq FALSE; yoqiq — dvigatel narxi', async () => {
    const off = makeProviderWorld();
    await off.s.markByProvider({ order_id: '8001', action: 'sell' });
    engineOn();
    const flagOff = makeProviderWorld({
      market: { weight_volume_pricing: false },
    });
    await flagOff.s.markByProvider({ order_id: '8001', action: 'sell' });
    expect(flagOff.rpc).not.toContain(SALE_QUOTE_PATTERN);
    expect(shape(flagOff.legs)).toEqual(shape(off.legs));
    expect({ ...flagOff.saved[0], sold_at: 0 }).toEqual({
      ...off.saved[0],
      sold_at: 0,
    });
    expect(off.saved[0]).toMatchObject({
      market_tariff: 45000,
      to_be_paid: 155000,
    });

    const on = makeProviderWorld();
    await on.s.markByProvider({ order_id: '8001', action: 'sell' });
    expect(on.rpc).toContain(SALE_QUOTE_PATTERN);
    expect(on.saved[0]).toMatchObject({
      market_tariff: 53000,
      to_be_paid: 147000,
      courier_share: 0,
      branch_share: 0,
    });
    expect(on.settlements[0]).toMatchObject({ market_amount: 147000 });
  });
});

describe('KmWO9gTA — ROLLBACK (market :2563, kuryer :2569)', () => {
  it('⭐ TC9: dvigatel narxi bilan sotuv → rollback: barcha kassalar net 0, qayta hisob yo`q', async () => {
    engineOn();
    const sale = makeSaleWorld();
    await sale.s.sellOrder(COURIER, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
    });
    expect(sale.updates[0]).toMatchObject({ market_tariff: 53000 });
    const soldOrder: Row = {
      ...WAITING_ORDER,
      ...sale.updates[0],
      holder_courier_id: '289',
      courier_id: '289',
    };
    // Rollbackgacha market profili ham, dvigatel ham o'zgargan bo'lsin —
    // teskari oyoq baribir SNAPSHOTdan.
    const rollback = makeRollbackWorld(
      soldOrder,
      { ...sale.settlements[0], isDeleted: false },
      { ...MARKET, tariff_center: 99000 },
    );
    await rollback.s.rollbackOrderToWaiting(SUPERADMIN, '7001');

    expect(rollback.rpc).not.toContain(SALE_QUOTE_PATTERN);
    expect(rollback.resets).toEqual(['7001']);
    const combined = net([...sale.legs, ...rollback.legs]);
    expect(combined.size).toBeGreaterThan(0);
    for (const [key, sum] of combined) {
      expect([key, sum]).toEqual([key, 0]);
    }
  });

  it('snapshotsiz ESKI sotuv rollbacki — profil tarifidan (dvigatel yoqiq bo`lsa ham)', async () => {
    engineOn();
    const legacySold: Row = {
      ...WAITING_ORDER,
      status: Order_status.SOLD,
      market_tariff: null,
      courier_tariff: 30000,
      courier_share: 30000,
      branch_share: 0,
      branch_cashbox_amount: 0,
      sale_collectible_amount: 250000,
      sold_at: '1759300000000',
      holder_courier_id: '289',
      courier_id: '289',
    };
    const rollback = makeRollbackWorld(legacySold, {
      order_id: '7001',
      status: 'pending',
      courier_id: '289',
      branch_id: '77',
      market_id: '501',
      courier_amount: 220000,
      branch_amount: 220000,
      market_amount: 205000,
      isDeleted: false,
    });
    await rollback.s.rollbackOrderToWaiting(SUPERADMIN, '7001');
    expect(rollback.rpc).not.toContain(SALE_QUOTE_PATTERN);
    const marketLeg = rollback.legs.find(
      (l) => l.cashbox_type === Cashbox_type.FOR_MARKET,
    );
    // 250 000 − profil 45 000 — aynan eski sotuv yozgan summa.
    expect(marketLeg).toMatchObject({
      amount: 205000,
      operation_type: Operation_type.EXPENSE,
    });
  });
});

describe('KmWO9gTA — bekor qilish (TC8)', () => {
  it('extra_cost va manfiy settlement qatori dvigatel yoqilganda ham AYNI', async () => {
    const off = makeSaleWorld();
    await off.s.cancelOrder(
      COURIER,
      '7001',
      { extraCost: 5000, extraCostApproved: true },
      'cancel-req-1',
    );
    engineOn();
    const on = makeSaleWorld();
    await on.s.cancelOrder(
      COURIER,
      '7001',
      { extraCost: 5000, extraCostApproved: true },
      'cancel-req-1',
    );
    expect(on.quoteCalls()).toHaveLength(0);
    expect(shape(on.legs)).toEqual(shape(off.legs));
    expect(on.settlements).toEqual(off.settlements);
    expect(on.updates).toEqual(off.updates);
  });
});

describe('KmWO9gTA — TC12: HQ qabul qilgandan keyin market_tariff qo`lda yozilmaydi', () => {
  const guard = (order: Row, dto: Row) => {
    const s = Object.create(OrderLifecycleService.prototype) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    return () => s.assertCommercialFieldsEditable(order, dto);
  };

  it('NEW / CREATED — ruxsat', () => {
    expect(
      guard(
        { status: Order_status.NEW, market_tariff: null },
        {
          market_tariff: 50000,
        },
      ),
    ).not.toThrow();
    expect(
      guard(
        { status: Order_status.CREATED, market_tariff: 1 },
        {
          market_tariff: null,
        },
      ),
    ).not.toThrow();
  });

  it('qabul qilingan (WAITING/SOLD) — o`zgartirish 400, o`sha qiymat — o`tadi', () => {
    for (const status of [Order_status.WAITING, Order_status.SOLD]) {
      expect(
        guard({ status, market_tariff: 45000 }, { market_tariff: 46000 }),
      ).toThrow(RpcException);
      expect(
        guard({ status, market_tariff: null }, { market_tariff: 0 }),
      ).toThrow(RpcException);
      expect(
        guard({ status, market_tariff: 45000 }, { market_tariff: 45000 }),
      ).not.toThrow();
      expect(guard({ status, market_tariff: 45000 }, {})).not.toThrow();
    }
  });
});

describe('KmWO9gTA — TC14: foyda hisoboti ataylab solishtirildi', () => {
  /** `order-analytics` PROFIT_SQL ning JS nusxasi (snapshot ustunlaridan). */
  const reportProfit = (rows: Row[]) =>
    rows.reduce(
      (sum, o) =>
        sum +
        (Number(o.market_tariff ?? 0) -
          Number(o.courier_share ?? o.courier_tariff ?? 0) -
          Number(o.branch_share ?? 0)),
      0,
    );

  it('SQL o`zgarmagan — snapshotdan; dvigatel sotuvida foyda = eski + qo`shimcha (+ floor)', async () => {
    const sql = (OrderAnalyticsService as unknown as { PROFIT_SQL: string })
      .PROFIT_SQL;
    expect(sql).toContain('COALESCE(o.market_tariff, 0)');
    expect(sql).toContain('COALESCE(o.courier_share, o.courier_tariff, 0)');

    const off = makeSaleWorld();
    await off.s.sellOrder(COURIER, '7001', {});
    engineOn();
    const on = makeSaleWorld();
    await on.s.sellOrder(COURIER, '7001', {});

    const before = reportProfit([off.updates[0]]);
    const after = reportProfit([on.updates[0]]);
    expect(before).toBe(computeSellProfit(45000, 30000, 0)); // 15 000
    expect(after).toBe(computeSellProfit(53000, 30000, 0)); // 23 000
    // Farq AYNAN vazn/hajm qo'shimchasi — hisobot ataylab oshadi.
    expect(after - before).toBe(8000);
    // `sell_profit` daftari (updateFull) ham AYNI formula — computeSellProfit
    // snapshot ustunlaridan, ya'ni hisobot == daftar saqlanadi.
  });
});
