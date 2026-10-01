/**
 * fix3c (MONEY-01) — KARGO (provider) SOTUVI YIG'ILADIGAN NAQDDAN YOZILADI.
 *
 * fix3b dan beri hamkorning prepaid posilkasida `paid_online_amount =
 * subtotal − cod_amount` saqlanadi va dispatch kargoga `total −
 * paid_online_amount` ni yig'ishni aytadi. `markByProvider` esa barcha pul
 * oyoqlarini `total_price` dan yozardi:
 *   • FOR_MARKET kirimi `total − tarif` (hech kim yig'MAGAN pul);
 *   • daftar `branch_amount = total`, snapshot `sale_collectible_amount =
 *     total` (hamkorga `collected_from_customer` shu ketadi);
 *   • javobdagi `total_price` dan integration `total` lik kargo qarzini
 *     yozardi — kargo hech narsa ushlamagan, qarz abadiy ochiq.
 *
 * Endi kargo sotuvi `sellOrder` bilan AYNI qoidada (`resolveCollectibleAmount`):
 * market oyog'i, daftar va snapshot yig'iladigan qismdan, kuryer/filial
 * oyoqlari o'rnida kargo qarzi (`cod_collected`) — u ham shu summa.
 */
import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  SettlementStatus,
  Source_type,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;

const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const COURIER = { id: '289', roles: ['courier'], branch_id: '22' };
/** Markaz tarifi 30 000 — barcha misollar CENTER yetkazish. */
const MARKET_TARIFF = 30000;
const MARKET = {
  id: '501',
  tariff_center: MARKET_TARIFF,
  tariff_home: 45000,
  expense_proof_conditions: [],
};

/**
 * Filial 22 da turgan hamkor posilkasi. `to_be_paid` — `createPartnerShipment`
 * dagi kabi COD (`total − prepaid`).
 */
function parcel(total: number, paidOnline: number, id = '8101'): Row {
  return {
    id,
    status: Order_status.WAITING,
    market_id: '501',
    customer_id: '801',
    total_price: total,
    paid_online_amount: paidOnline,
    to_be_paid: total - paidOnline,
    paid_amount: 0,
    where_deliver: Where_deliver.CENTER,
    market_tariff: null,
    courier_tariff: null,
    courier_share: null,
    branch_share: null,
    branch_cashbox_amount: null,
    sale_collectible_amount: null,
    extra_cost: 0,
    branch_id: '22',
    home_branch_id: '22',
    holder_branch_id: '22',
    holder_courier_id: '289',
    courier_id: '289',
    post_id: '9001',
    sold_at: null,
    comment: null,
    external_id: 'EXT-1',
  };
}

const FULLY_PREPAID = { total: 200000, online: 200000 };
const PARTLY_PREPAID = { total: 300000, online: 200000 };
const NOT_PREPAID = { total: 200000, online: 0 };

// ───────────────────────── harnesslar ─────────────────────────

/** Haqiqiy `markByProvider` — kassa/daftar/outbox tutib olinadi. */
function makeProviderHarness(order: Row) {
  const saved: Row[] = [];
  const legs: Row[] = [];
  const settlements: Row[] = [];
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
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    outbox,
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { createTrackingEvent: jest.fn().mockResolvedValue(undefined) },
    lookup: { getMarketsByIds: jest.fn().mockResolvedValue([MARKET]) },
    // Javob (`updated`) tranzaksiyada saqlangan holatni ko'radi.
    findById: jest.fn(() =>
      Promise.resolve({ ...(saved[saved.length - 1] ?? order) }),
    ),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });
  return { s, saved, legs, settlements, outbox };
}

/** Haqiqiy `sellOrder` (kuryer 289) — taqqoslash uchun (fix3b harnessi). */
function makeSellHarness(order: Row) {
  const legs: Row[] = [];
  const settlements: Row[] = [];
  const updates: Row[] = [];
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
      if (entity === OrderItem) return {};
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
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([MARKET]),
      getCouriersByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '289', tariff_center: 25000, tariff_home: 35000 },
        ]),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('22'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn().mockResolvedValue(order),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });
  return { s, legs, settlements, updates };
}

/** Haqiqiy `rollbackOrderToWaiting` (fix3b-provider-snapshots harnessi). */
function makeRollbackHarness(order: Row, settlement: Row) {
  const legs: Row[] = [];
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
  const updateFull = jest.fn().mockResolvedValue(order);
  const resetSettlementOnRollback = jest.fn().mockResolvedValue(undefined);
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    orderSettlementRepo: { findOne: jest.fn().mockResolvedValue(settlement) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([MARKET]),
      getCouriersByIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({ id, tariff_center: 25000, tariff_home: 35000 })),
        ),
      ),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('22'),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn().mockResolvedValue(order),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
    resetSettlementOnRollback,
    updateFull,
    mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  return { s, legs, updateFull, resetSettlementOnRollback };
}

const marketLegs = (legs: Row[]) =>
  legs
    .filter((leg) => leg.cashbox_type === Cashbox_type.FOR_MARKET)
    .map((leg) => [leg.operation_type, leg.source_type, leg.amount]);

const signed = (legs: Row[], type: Cashbox_type) =>
  legs
    .filter((leg) => leg.cashbox_type === type)
    .reduce(
      (sum, leg) =>
        sum +
        (leg.operation_type === Operation_type.INCOME ? 1 : -1) *
          Number(leg.amount),
      0,
    );

async function providerSell(order: Row) {
  const h = makeProviderHarness(order);
  const res = await h.s.markByProvider({
    order_id: String(order.id),
    action: 'sell',
    provider_slug: 'acme-cargo',
    external_ref: 'ACME-9',
  });
  return { ...h, res: res as { data: Row } };
}

// ───────────────────────── testlar ─────────────────────────

describe('fix3c — markByProvider: oyoqlar yig`iladigan naqddan (MONEY-01)', () => {
  it('⭐ to`liq prepaid (COD 0): marketdan faqat tarif, daftar 0, kargo qarzi 0', async () => {
    const h = await providerSell(
      parcel(FULLY_PREPAID.total, FULLY_PREPAID.online),
    );

    // Market oyog'i: naqd yo'q — yetkazish haqi marketdan olinadi. Ilgari:
    // 200 000 − 30 000 = 170 000 KIRIM (hech kim yig'magan pul).
    expect(marketLegs(h.legs)).toEqual([
      [Operation_type.EXPENSE, Source_type.SELL, MARKET_TARIFF],
    ]);
    // Kuryer/filial kassasiga hech narsa yozilmaydi.
    expect(h.legs.map((leg) => leg.cashbox_type)).toEqual([
      Cashbox_type.FOR_MARKET,
    ]);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      status: Order_status.SOLD,
      sale_collectible_amount: 0,
      branch_cashbox_amount: 0,
      to_be_paid: 0,
      market_tariff: MARKET_TARIFF,
      courier_share: 0,
      branch_share: 0,
    });

    expect(h.settlements).toEqual([
      expect.objectContaining({
        courier_id: null,
        branch_id: null,
        courier_amount: 0,
        branch_amount: 0,
        market_amount: -MARKET_TARIFF,
        status: SettlementStatus.PENDING,
      }),
    ]);

    // Kargo qarzi = 0 → integration uni `<= 0` tarmog'ida yozmaydi.
    expect(h.res.data).toMatchObject({
      status: Order_status.SOLD,
      cod_collected: 0,
      // Moslik uchun o'zgarmagan.
      total_price: FULLY_PREPAID.total,
    });
  });

  it('⭐ qisman prepaid (COD 100 000 / 300 000): kargo qarzi 100 000', async () => {
    const h = await providerSell(
      parcel(PARTLY_PREPAID.total, PARTLY_PREPAID.online),
    );

    // 100 000 − 30 000 = 70 000 (ilgari 300 000 − 30 000 = 270 000).
    expect(marketLegs(h.legs)).toEqual([
      [Operation_type.INCOME, Source_type.SELL, 70000],
    ]);
    expect(h.saved[0]).toMatchObject({
      sale_collectible_amount: 100000,
      to_be_paid: 70000,
    });
    expect(h.settlements[0]).toMatchObject({
      branch_amount: 100000,
      market_amount: 70000,
      status: SettlementStatus.PENDING,
    });
    expect(h.res.data).toMatchObject({
      cod_collected: 100000,
      total_price: PARTLY_PREPAID.total,
    });
    // Kargo remittance'i MAIN ga aynan qarzni yozadi — `markProviderSettledToHq`
    // "HQ'ga yetdi" deb belgilaydigan qator ham aynan shu summa.
    expect(h.res.data.cod_collected).toBe(h.settlements[0].branch_amount);
  });

  it('regressiya: prepaid emas — summalar o`zgarmaydi', async () => {
    const h = await providerSell(parcel(NOT_PREPAID.total, NOT_PREPAID.online));

    expect(marketLegs(h.legs)).toEqual([
      [Operation_type.INCOME, Source_type.SELL, 170000],
    ]);
    expect(h.saved[0]).toMatchObject({
      sale_collectible_amount: 200000,
      to_be_paid: 170000,
      branch_cashbox_amount: 0,
    });
    expect(h.settlements[0]).toMatchObject({
      courier_amount: 0,
      branch_amount: 200000,
      market_amount: 170000,
      status: SettlementStatus.PENDING,
    });
    expect(h.res.data).toMatchObject({
      cod_collected: 200000,
      total_price: 200000,
    });
  });

  it('`paid_online_amount` yo`q (eski qator) — avvalgidek total', async () => {
    const order = parcel(NOT_PREPAID.total, 0);
    delete order.paid_online_amount;

    const h = await providerSell(order);

    expect(h.res.data).toMatchObject({ cod_collected: 200000 });
    expect(h.settlements[0]).toMatchObject({ branch_amount: 200000 });
  });

  it('foyda (sell_profit) = tarif, prepaid bo`lsa ham (sellOrder ilgagi bilan bir xil)', async () => {
    const h = await providerSell(
      parcel(FULLY_PREPAID.total, FULLY_PREPAID.online),
    );

    const calls = h.outbox.enqueue.mock.calls as unknown[][];
    const profit = calls
      .filter((call) => call[1] === 'finance.financial_balance.record')
      .map((call) => call[2] as Row)
      .find((payload) => payload?.source_type === 'sell_profit');
    expect(profit).toMatchObject({ amount: MARKET_TARIFF });
  });

  it('cancel/return javobida `cod_collected` yo`q (kargo qarzi faqat sotuvda)', async () => {
    const h = makeProviderHarness(parcel(300000, 200000));

    const res = (await h.s.markByProvider({
      order_id: '8101',
      action: 'cancel',
    })) as { data: Row };

    expect(res.data).not.toHaveProperty('cod_collected');
    expect(h.legs).toEqual([]);
    expect(h.settlements).toEqual([]);
  });
});

describe('⭐ fix3c — kargo sotuvi = kuryer sotuvining market tomoni (sellOrder ko`zgusi)', () => {
  it.each([
    ['to`liq prepaid', FULLY_PREPAID],
    ['qisman prepaid', PARTLY_PREPAID],
    ['prepaid emas', NOT_PREPAID],
  ])(
    '%s: market oyog`i, daftar market_amount, snapshot va to_be_paid AYNI',
    async (_label, money) => {
      const courierSale = makeSellHarness(parcel(money.total, money.online));
      await courierSale.s.sellOrder(COURIER, '8101', {});

      const provider = await providerSell(parcel(money.total, money.online));

      // FOR_MARKET oyog'i (tur, manba, summa) — bir xil.
      expect(marketLegs(provider.legs)).toEqual(marketLegs(courierSale.legs));
      // Daftarning market qismi — bir xil.
      expect(provider.settlements[0].market_amount).toBe(
        courierSale.settlements[0].market_amount,
      );
      // Yig'ilgan naqd snapshoti va marketga to'lanadigan qism — bir xil.
      expect(provider.saved[0].sale_collectible_amount).toBe(
        courierSale.updates[0].sale_collectible_amount,
      );
      expect(provider.saved[0].to_be_paid).toBe(
        courierSale.updates[0].to_be_paid,
      );
      // Kuryer/filial oyoqlari o'rnida — kargo qarzi: kuryer yig'adigan AYNI
      // naqd.
      expect(provider.res.data.cod_collected).toBe(
        courierSale.updates[0].sale_collectible_amount,
      );
      expect(provider.settlements[0].branch_amount).toBe(
        courierSale.updates[0].sale_collectible_amount,
      );
    },
  );
});

describe('⭐ fix3c — SA rollback: prepaid kargo sotuvi aynan 0 ga qaytadi', () => {
  it.each([
    [
      'to`liq prepaid',
      FULLY_PREPAID,
      [Operation_type.INCOME, Source_type.CORRECTION, MARKET_TARIFF],
    ],
    [
      'qisman prepaid',
      PARTLY_PREPAID,
      [Operation_type.EXPENSE, Source_type.CORRECTION, 70000],
    ],
  ])(
    '%s: market oyog`i net 0, kuryer/filial kassasi tegilmaydi',
    async (_label, money, reversal) => {
      const sale = await providerSell(parcel(money.total, money.online));
      const soldOrder = { ...sale.saved[0] };
      const settlement = { ...sale.settlements[0], isDeleted: false };
      // Naqd kargoda (yoki umuman yo'q) — qator HQ'ga yetmagan, rollback ochiq.
      expect(settlement.status).toBe(SettlementStatus.PENDING);

      const rollback = makeRollbackHarness(soldOrder, settlement);
      await rollback.s.rollbackOrderToWaiting(SUPERADMIN, '8101');

      expect(marketLegs(rollback.legs)).toEqual([reversal]);
      expect(
        signed([...sale.legs, ...rollback.legs], Cashbox_type.FOR_MARKET),
      ).toBe(0);
      expect(
        rollback.legs.filter(
          (leg) =>
            leg.cashbox_type === Cashbox_type.BRANCH ||
            leg.cashbox_type === Cashbox_type.FOR_COURIER,
        ),
      ).toEqual([]);
      // Daftar qatori tozalanadi, snapshot o'chadi (keyingi sotuv yangidan).
      expect(rollback.resetSettlementOnRollback).toHaveBeenCalledTimes(1);
      expect(rollback.updateFull).toHaveBeenCalledWith(
        '8101',
        expect.objectContaining({
          status: Order_status.WAITING,
          to_be_paid: 0,
          sale_collectible_amount: null,
        }),
        expect.anything(),
        expect.anything(),
      );
    },
  );
});

describe('⭐ fix3c — hamkorga `collected_from_customer` = yig`ilgan naqd', () => {
  it.each([
    ['to`liq prepaid', FULLY_PREPAID, 0, -MARKET_TARIFF],
    ['qisman prepaid', PARTLY_PREPAID, 100000, 70000],
    ['prepaid emas', NOT_PREPAID, 200000, 170000],
  ])('%s', async (_label, money, collected, marketAmount) => {
    const sale = await providerSell(parcel(money.total, money.online));
    const send = jest.fn(() => of({}));
    const s = Object.create(OrderLifecycleService.prototype) as Svc;
    Object.assign(s, { integrationClient: { send } });

    // Hamkor webhooki buyurtmadagi snapshotdan o'qiydi — kargo sotuvi
    // yozgan qator bilan.
    await s.queueExternalStatusSync(
      sale.saved[0] as unknown as Order,
      'sold',
      Order_status.WAITING,
      Order_status.SOLD,
    );

    expect(send).toHaveBeenCalledWith(
      { cmd: 'integration.partner.webhook.enqueue' },
      expect.objectContaining({
        collected_from_customer: collected,
        elchi_fee: MARKET_TARIFF,
        market_amount: marketAmount,
        total_price: money.total,
      }),
    );
  });
});
