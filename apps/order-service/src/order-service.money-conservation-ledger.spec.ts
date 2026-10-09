/**
 * MONEY-CONSERVATION: KASSA TARIXI == SETTLEMENT DAFTARI (ZsPLevZZ).
 *
 * `order-service.money-conservation.spec.ts` sof formulani (computeSaleLegs)
 * sinaydi. Bu spec esa HAQIQIY `sellOrder` ni xotiradagi ikki daftar ustida
 * yuritadi va `scripts/check-cashbox-invariant.ts` (--reconcile-strict) prodda
 * DB'da tekshiradigan identiklikni DB'siz qulflaydi:
 *
 *   har market uchun:  SUM(cashbox_history, FOR_MARKET, income − expense)
 *                   == SUM(order_settlement.market_amount)  (market_settled emas)
 *   har kuryer uchun:  SUM(cashbox_history, FOR_COURIER, income − expense)
 *                   == SUM(order_settlement.courier_amount)
 *
 * ⚠️ ZsPLevZZ. Ilgari `sell {paidAmount}` buyurtmani "paid" qilardi, market
 * kassasiga esa baribir TO'LIQ daromad yozilar, settlement esa PENDING
 * qolardi — ikki daftar ajralardi. Endi paidAmount > 0 — 400 va HECH QANDAY
 * kassa/settlement yozuvi qolmaydi; paidAmount'siz (yoki 0) sotuvda esa
 * identiklik saqlanadi. Ikkala holat bitta ketma-ketlikda aralash sinaladi.
 *
 * Xotiradagi repo TRANZAKSIYALI: outbox (kassa oyog'i), settlement qatori va
 * buyurtma holati faqat `commitTransaction` da daftarga tushadi,
 * `rollbackTransaction` da tashlab yuboriladi — prod'dagi kabi.
 * `updateCashboxBalance` va `recordSaleSettlement` ATAYLAB haqiqiy qoladi.
 */
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import {
  Cashbox_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, any>;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sum = (values: number[]): number =>
  round2(values.reduce((acc, v) => acc + Number(v), 0));

/** `check-cashbox-invariant.ts` dagi kabi: income → +, expense → −. */
const signed = (h: Row): number =>
  h.operation_type === 'income'
    ? Number(h.amount)
    : h.operation_type === 'expense'
      ? -Number(h.amount)
      : 0;

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode?: number; message?: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

interface Ledgers {
  cashboxHistory: Row[];
  settlements: Row[];
  orders: Map<string, Row>;
}

const PARTNER_BRANCH = '77';
const PARTNER_BRANCH_SHARE = 3000;
const MANAGER = { id: '201', roles: ['manager'], branch_id: PARTNER_BRANCH };

function makeWorld(opts: { markets: Row[]; couriers: Row[]; orders: Row[] }) {
  const ledgers: Ledgers = {
    cashboxHistory: [],
    settlements: [],
    orders: new Map(opts.orders.map((o) => [String(o.id), { ...o }])),
  };
  const markets = new Map(opts.markets.map((m) => [String(m.id), m]));
  const couriers = new Map(opts.couriers.map((c) => [String(c.id), c]));
  /** Har tranzaksiya menejeri → commit kutayotgan yozuvlar. */
  const pending = new WeakMap<object, Array<() => void>>();
  let settlementSeq = 0;

  const createQueryRunner = () => {
    const ops: Array<() => void> = [];
    const settlementRepo = {
      findOne: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          ledgers.settlements.find(
            (r) => r.order_id === String(where.order_id),
          ) ?? null,
        ),
      ),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => {
        const saved = { id: `S${++settlementSeq}`, ...row };
        ops.push(() => ledgers.settlements.push(saved));
        return Promise.resolve(saved);
      }),
      update: jest.fn(({ id }: { id: string }, fields: Row) => {
        ops.push(() => {
          const target = ledgers.settlements.find((r) => r.id === id);
          if (target) Object.assign(target, fields);
        });
        return Promise.resolve({ affected: 1 });
      }),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
      ),
    };
    pending.set(manager, ops);
    return {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(() => {
        ops.splice(0).forEach((apply) => apply());
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        ops.splice(0);
        return Promise.resolve();
      }),
      release: jest.fn(),
    };
  };

  /** Tranzaksiya ichida bo'lsa commit'gacha kutadi, aks holda darhol. */
  const write = (manager: object | undefined, apply: () => void) => {
    const ops = manager ? pending.get(manager) : undefined;
    if (ops) ops.push(apply);
    else apply();
  };

  const cashboxBalance = (userId: string, type: Cashbox_type): number =>
    sum(
      ledgers.cashboxHistory
        .filter((h) => h.user_id === userId && h.cashbox_type === type)
        .map(signed),
    );

  const s = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(createQueryRunner) },
    logisticsClient: {
      send: jest.fn((_pattern: unknown, payload: { id: string }) =>
        of({
          data: {
            id: payload.id,
            courier_id: String(payload.id).replace(/^P-/, ''),
          },
        }),
      ),
    },
    outbox: {
      enqueue: jest.fn(
        (
          _target: string,
          pattern: string,
          payload: Row,
          options?: { manager?: object },
        ) => {
          // Finance-service shu hodisadan `cashbox_history` qatorini yozadi.
          if (pattern === 'finance.cashbox.update_balance') {
            write(options?.manager, () =>
              ledgers.cashboxHistory.push({ ...payload }),
            );
          }
          return Promise.resolve(undefined);
        },
      ),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map((id) => markets.get(String(id)))),
      ),
      getCouriersByIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map((id) => couriers.get(String(id)))),
      ),
      getUserById: jest.fn().mockResolvedValue({
        id: MANAGER.id,
        branch_id: PARTNER_BRANCH,
        can_add_extra_cost: true,
        can_sell_cancel: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      // Qoldiq daftardan hisoblanadi — market qarzi (autoPay) ham haqiqiy.
      getCashboxByUser: jest.fn((id: string, type: Cashbox_type) =>
        Promise.resolve({
          id: `${type}-${id}`,
          balance: cashboxBalance(String(id), type),
        }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn((order: Row) =>
        Promise.resolve(order.branch_id ?? null),
      ),
      resolveBranchShare: jest.fn((branchId: string) =>
        Promise.resolve(branchId === PARTNER_BRANCH ? PARTNER_BRANCH_SHARE : 0),
      ),
    },
    // Tekshirilayotgan pul mantig'idan tashqaridagi yo'llar.
    findById: jest.fn((id: string) =>
      Promise.resolve({ ...ledgers.orders.get(String(id)) }),
    ),
    updateFull: jest.fn(
      (id: string, patch: Row, _actor: unknown, manager?: object) => {
        write(manager, () =>
          Object.assign(ledgers.orders.get(String(id)) ?? {}, patch),
        );
        return Promise.resolve(undefined);
      },
    ),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });

  return { s, ledgers };
}

/**
 * Identiklik — `check-cashbox-invariant.ts` ning settlement↔cashbox bo'limi
 * (markets) + kuryer bo'g'ini. Har market/kuryer alohida VA jami.
 */
function expectLedgersConserve(ledgers: Ledgers): void {
  const open = ledgers.settlements.filter(
    (r) => r.status !== SettlementStatus.MARKET_SETTLED,
  );
  const marketIds = new Set([
    ...open.map((r) => String(r.market_id)),
    ...ledgers.cashboxHistory
      .filter((h) => h.cashbox_type === Cashbox_type.FOR_MARKET)
      .map((h) => String(h.user_id)),
  ]);
  for (const marketId of marketIds) {
    const cashbox = sum(
      ledgers.cashboxHistory
        .filter(
          (h) =>
            h.cashbox_type === Cashbox_type.FOR_MARKET &&
            String(h.user_id) === marketId,
        )
        .map(signed),
    );
    const owed = sum(
      open
        .filter((r) => String(r.market_id) === marketId)
        .map((r) => r.market_amount),
    );
    expect({ marketId, diff: round2(cashbox - owed) }).toEqual({
      marketId,
      diff: 0,
    });
  }

  const courierIds = new Set([
    ...open.filter((r) => r.courier_id).map((r) => String(r.courier_id)),
    ...ledgers.cashboxHistory
      .filter((h) => h.cashbox_type === Cashbox_type.FOR_COURIER)
      .map((h) => String(h.user_id)),
  ]);
  for (const courierId of courierIds) {
    const cashbox = sum(
      ledgers.cashboxHistory
        .filter(
          (h) =>
            h.cashbox_type === Cashbox_type.FOR_COURIER &&
            String(h.user_id) === courierId,
        )
        .map(signed),
    );
    const owed = sum(
      open
        .filter((r) => String(r.courier_id) === courierId)
        .map((r) => r.courier_amount),
    );
    expect({ courierId, diff: round2(cashbox - owed) }).toEqual({
      courierId,
      diff: 0,
    });
  }

  // Jami: SUM(cashbox_history, markets) == SUM(order_settlement.market_amount).
  expect(
    sum(
      ledgers.cashboxHistory
        .filter((h) => h.cashbox_type === Cashbox_type.FOR_MARKET)
        .map(signed),
    ),
  ).toBe(sum(open.map((r) => r.market_amount)));
}

// ---------------------------------------------------------------------------
// Andijon E2E dagi ssenariy (POST /orders/sell/1251167 {paidAmount:105000}).
// ---------------------------------------------------------------------------
const E2E_MARKET = {
  id: '121',
  tariff_center: 45000,
  tariff_home: 70000,
  expense_proof_conditions: [],
};
const E2E_COURIER = {
  id: '301',
  tariff_center: 30000,
  tariff_home: 50000,
  can_add_extra_cost: true,
  can_sell_cancel: true,
};
const e2eOrder = (id: string): Row => ({
  id,
  status: Order_status.WAITING,
  post_id: 'P-301',
  market_id: '121',
  // collectible 150 000 − market tarifi 45 000 = 105 000 (E2E dagi summa).
  total_price: 150000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: null,
  comment: null,
});
const COURIER = { id: '301', roles: ['courier'], branch_id: null };

describe('ZsPLevZZ — kassa tarixi == settlement daftari (sotuv)', () => {
  it('⭐ paidAmount`siz: market +105 000 == market_amount 105 000, holat SOLD', async () => {
    const { s, ledgers } = makeWorld({
      markets: [E2E_MARKET],
      couriers: [E2E_COURIER],
      orders: [e2eOrder('1251167')],
    });

    await s.sellOrder(COURIER, '1251167', {});

    expect(ledgers.settlements).toHaveLength(1);
    expect(ledgers.settlements[0]).toMatchObject({
      market_amount: 105000,
      courier_amount: 120000,
      status: SettlementStatus.PENDING,
      hq_to_market_at: null,
    });
    expect(
      ledgers.cashboxHistory.find(
        (h) => h.cashbox_type === Cashbox_type.FOR_MARKET,
      ),
    ).toMatchObject({ amount: 105000, operation_type: 'income' });
    // Buyurtma "to'landi" demaydi — kassa ham "hali qarzdormiz" deydi.
    expect(ledgers.orders.get('1251167')).toMatchObject({
      status: Order_status.SOLD,
      paid_amount: 0,
      to_be_paid: 105000,
    });
    expectLedgersConserve(ledgers);
  });

  it('⭐ paidAmount bilan: 400, kassa VA settlement yozuvi YO`Q (ikkala yig`indi 0)', async () => {
    const { s, ledgers } = makeWorld({
      markets: [E2E_MARKET],
      couriers: [E2E_COURIER],
      orders: [e2eOrder('1251167')],
    });

    const error = await rpcError(
      s.sellOrder(COURIER, '1251167', { paidAmount: 105000 }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('paidAmount');
    expect(ledgers.cashboxHistory).toHaveLength(0);
    expect(ledgers.settlements).toHaveLength(0);
    expect(ledgers.orders.get('1251167')).toMatchObject({
      status: Order_status.WAITING,
      paid_amount: 0,
    });
    // Tranzaksiya umuman ochilmaydi — yarim yozilgan oyoq ham qolmaydi.
    expect(s.dataSource.createQueryRunner).not.toHaveBeenCalled();
    expectLedgersConserve(ledgers);
  });

  it('paidAmount rad etilgach odatiy sotuv — identiklik saqlanadi, ikki marta yozilmaydi', async () => {
    const { s, ledgers } = makeWorld({
      markets: [E2E_MARKET],
      couriers: [E2E_COURIER],
      orders: [e2eOrder('1251167')],
    });

    await rpcError(s.sellOrder(COURIER, '1251167', { paidAmount: 105000 }));
    await s.sellOrder(COURIER, '1251167', {});
    // Qayta sotish urinishi (buyurtma endi WAITING emas) — daftar o'zgarmaydi.
    const again = await rpcError(s.sellOrder(COURIER, '1251167', {}));

    expect(again.statusCode).toBe(400);
    expect(ledgers.settlements).toHaveLength(1);
    expect(
      ledgers.cashboxHistory.filter(
        (h) => h.cashbox_type === Cashbox_type.FOR_MARKET,
      ),
    ).toHaveLength(1);
    expectLedgersConserve(ledgers);
  });

  it('paidAmount: 0 — paidAmount`siz bilan AYNAN bir xil daftar', async () => {
    const run = async (dto: Row) => {
      const { s, ledgers } = makeWorld({
        markets: [E2E_MARKET],
        couriers: [E2E_COURIER],
        orders: [e2eOrder('1251167')],
      });
      await s.sellOrder(COURIER, '1251167', dto);
      return {
        history: ledgers.cashboxHistory.map((h) => [
          h.cashbox_type,
          h.operation_type,
          h.amount,
        ]),
        settlement: ledgers.settlements.map((r) => [
          r.market_amount,
          r.courier_amount,
          r.branch_amount,
          r.status,
        ]),
      };
    };

    expect(await run({ paidAmount: 0 })).toEqual(await run({}));
  });
});

// ---------------------------------------------------------------------------
// Xossa testi: aralash ketma-ketlik (money-conservation.spec naqshida —
// deterministik psevdo-tasodif, Math.random yo'q).
// ---------------------------------------------------------------------------
describe('⭐ ZsPLevZZ — aralash ketma-ketlikda har qadamdan keyin identiklik', () => {
  let seed = 20261009;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
  const som = (max: number) => Math.round(next() * max);

  const couriers = ['301', '302', '303'].map((id) => {
    const center = 10000 + som(20000);
    return {
      id,
      tariff_center: center,
      tariff_home: center + 5000 + som(20000),
      can_add_extra_cost: true,
      can_sell_cancel: true,
    };
  });
  const maxCenter = Math.max(...couriers.map((c) => c.tariff_center));
  const maxHome = Math.max(...couriers.map((c) => c.tariff_home));
  // Tarif qo'riqchisi: market tarifi har qanday kuryer + filial ulushini qoplaydi.
  const markets = ['501', '502', '503', '504'].map((id) => ({
    id,
    tariff_center: maxCenter + PARTNER_BRANCH_SHARE + som(20000),
    tariff_home: maxHome + PARTNER_BRANCH_SHARE + som(20000),
    expense_proof_conditions: [],
  }));

  type Step = {
    order: Row;
    requester: Row;
    paidAmount?: number;
    dto: Row;
  };

  const steps: Step[] = [];
  for (let k = 0; k < 240; k++) {
    const id = String(9000 + k);
    // Ba'zan 0 so'mlik yoki tarifdan arzon buyurtma — teskari oyoqlar yo'li.
    const total = next() < 0.08 ? som(20000) : som(900000);
    const online = pick(['none', 'none', 'none', 'full', 'part']);
    const paidOnline =
      online === 'full' ? total : online === 'part' ? som(total) : 0;
    const isManager = next() < 0.3;
    const courier = pick(couriers);
    const atPartnerBranch = isManager || next() < 0.5;
    const whereDeliver =
      next() < 0.6 ? Where_deliver.CENTER : Where_deliver.ADDRESS;
    // Kuryer sotuvida xarajat faqat markazga, chegarasi uy − markaz tarifi.
    const extraCostMax = isManager
      ? 20000
      : whereDeliver === Where_deliver.CENTER
        ? courier.tariff_home - courier.tariff_center
        : 0;
    const extraCost = extraCostMax > 0 && next() < 0.3 ? som(extraCostMax) : 0;
    const order: Row = {
      id,
      status: Order_status.WAITING,
      post_id: `P-${courier.id}`,
      market_id: pick(markets).id,
      total_price: total,
      paid_online_amount: paidOnline,
      paid_amount: 0,
      where_deliver: whereDeliver,
      branch_id: atPartnerBranch ? PARTNER_BRANCH : null,
      holder_branch_id: atPartnerBranch ? PARTNER_BRANCH : null,
      // Menejer faqat filialda turgan (kuryerda bo'lmagan) buyurtmani sotadi.
      courier_id: isManager ? null : courier.id,
      comment: null,
    };
    steps.push({
      order,
      requester: isManager
        ? MANAGER
        : { id: courier.id, roles: ['courier'], branch_id: null },
      // Har uchinchi buyurtmada avval paidAmount bilan urinish.
      paidAmount: next() < 0.35 ? 1 + som(total) : undefined,
      dto: extraCost > 0 ? { extraCost, extraCostApproved: true } : {},
    });
  }

  it('paidAmount > 0 — har safar 400 va izsiz; busiz — SUM(kassa) == SUM(settlement)', async () => {
    const { s, ledgers } = makeWorld({
      markets,
      couriers,
      orders: steps.map((step) => step.order),
    });
    let rejected = 0;
    let sold = 0;

    for (const step of steps) {
      if (step.paidAmount !== undefined) {
        const historyBefore = ledgers.cashboxHistory.length;
        const settlementsBefore = ledgers.settlements.length;

        const error = await rpcError(
          s.sellOrder(step.requester, step.order.id, {
            ...step.dto,
            paidAmount: step.paidAmount,
          }),
        );

        expect(error.statusCode).toBe(400);
        expect(ledgers.cashboxHistory).toHaveLength(historyBefore);
        expect(ledgers.settlements).toHaveLength(settlementsBefore);
        expect(ledgers.orders.get(step.order.id)?.status).toBe(
          Order_status.WAITING,
        );
        rejected += 1;
        expectLedgersConserve(ledgers);
      }

      /**
       * `paid_amount` FAQAT market qarzidan avtomatik yopilgan qism (autoPay):
       * sotuvdan oldingi market qoldig'i manfiy bo'lsa, shu qism. U yangi
       * kassa oyog'i emas va dto'dan (rad etilgan paidAmount'dan) kelmaydi.
       */
      const marketDebt = Math.max(
        -sum(
          ledgers.cashboxHistory
            .filter(
              (h) =>
                h.cashbox_type === Cashbox_type.FOR_MARKET &&
                h.user_id === String(step.order.market_id),
            )
            .map(signed),
        ),
        0,
      );

      await s.sellOrder(step.requester, step.order.id, step.dto);
      sold += 1;

      const order = ledgers.orders.get(step.order.id) as Row;
      expect(order.paid_amount).toBe(
        Math.min(Number(order.to_be_paid), marketDebt),
      );
      expectLedgersConserve(ledgers);
    }

    // Ketma-ketlik haqiqatan ham ikkala yo'lni va qiyin holatlarni qamragan.
    expect(rejected).toBeGreaterThan(50);
    expect(sold).toBe(steps.length);
    expect(ledgers.settlements).toHaveLength(steps.length);
    const marketLegs = ledgers.cashboxHistory.filter(
      (h) => h.cashbox_type === Cashbox_type.FOR_MARKET,
    );
    expect(marketLegs.some((h) => h.source_type === 'extra_cost')).toBe(true);
    // Onlayn to'langan buyurtma: market bizga qarzdor (EXPENSE oyog'i).
    expect(
      marketLegs.some(
        (h) => h.source_type === 'sell' && h.operation_type === 'expense',
      ),
    ).toBe(true);
  });
});
