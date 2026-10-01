/**
 * fix3b — kargo (provider) sotuvi snapshotlari va HQ hisob-kitobi.
 *
 *   1. `markByProvider` (sell) endi `branch_cashbox_amount = 0` va
 *      `sale_collectible_amount = total` yozadi (L1 ochiq masalasi). Ilgari
 *      ular NULL qolar, rollback esa NULL zaxirasi bilan filialda turgan
 *      buyurtma uchun HECH QACHON yozilmagan filial oyog'ini (`saleBranchNet`)
 *      teskari yozardi.
 *   2. `markProviderSettledToHq` — `branch_to_hq_by` (bigint) ga `'system'`
 *      emas, raqam yoki NULL (A4 ochiq masalasi; 22P02 butun update'ni
 *      yiqitardi).
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
import { OrderSettlementService } from './settlement/order-settlement.service';
import { Order } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;

const SUPERADMIN = { id: '1', roles: ['superadmin'] };

/** Filial 22 da turgan, kargo yetkazgan buyurtma. */
const PROVIDER_ORDER: Row = {
  id: '8001',
  status: Order_status.WAITING,
  market_id: '501',
  customer_id: '801',
  total_price: 200000,
  paid_online_amount: 0,
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
};

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
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { createTrackingEvent: jest.fn().mockResolvedValue(undefined) },
    lookup: {
      getMarketsByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '501', tariff_center: 30000, tariff_home: 45000 },
        ]),
    },
    findById: jest.fn(() => Promise.resolve({ ...order })),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });
  return { s, saved, legs, settlements };
}

/** L1 rollback harnessining qisqa nusxasi — pul mantig'i HAQIQIY. */
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
      getMarketsByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '501', tariff_center: 30000, tariff_home: 45000 },
        ]),
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
    resetSettlementOnRollback: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn().mockResolvedValue(order),
    mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  return { s, legs };
}

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

describe('fix3b — markByProvider sotuv snapshotlari', () => {
  it('⭐ sell: branch_cashbox_amount = 0, sale_collectible_amount = total', async () => {
    const h = makeProviderHarness(PROVIDER_ORDER);

    await h.s.markByProvider({
      order_id: '8001',
      action: 'sell',
      provider_slug: 'beepost',
    });

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      status: Order_status.SOLD,
      branch_cashbox_amount: 0,
      sale_collectible_amount: 200000,
      courier_share: 0,
      branch_share: 0,
      market_tariff: 30000,
    });
    // Filial kassasiga hech narsa yozilmaydi — faqat market oyog'i.
    expect(h.legs.map((leg) => leg.cashbox_type)).toEqual([
      Cashbox_type.FOR_MARKET,
    ]);
  });

  it('cancel/return yo`lida snapshotga tegilmaydi', async () => {
    const h = makeProviderHarness(PROVIDER_ORDER);

    await h.s.markByProvider({ order_id: '8001', action: 'cancel' });

    expect(h.saved[0]).toMatchObject({
      status: Order_status.CANCELLED,
      branch_cashbox_amount: null,
      sale_collectible_amount: null,
    });
  });

  it('⭐ kargo sotuvi → superadmin rollback: filial kassasi TEGILMAYDI, market oyog`i aynan qaytadi', async () => {
    const sale = makeProviderHarness(PROVIDER_ORDER);
    await sale.s.markByProvider({ order_id: '8001', action: 'sell' });

    const soldOrder = { ...sale.saved[0] };
    const settlement = { ...sale.settlements[0], isDeleted: false };
    expect(settlement).toMatchObject({
      courier_id: null,
      branch_id: null,
      status: SettlementStatus.PENDING,
    });

    const rollback = makeRollbackHarness(soldOrder, settlement);
    await rollback.s.rollbackOrderToWaiting(SUPERADMIN, '8001');

    // Ilgari: NULL zaxirasi bilan BRANCH kassasidan 200 000 CHIQIM.
    expect(
      rollback.legs.filter((leg) => leg.cashbox_type === Cashbox_type.BRANCH),
    ).toEqual([]);
    expect(
      rollback.legs.filter(
        (leg) => leg.cashbox_type === Cashbox_type.FOR_COURIER,
      ),
    ).toEqual([]);
    // Market: sotuv +170 000, rollback −170 000 → net 0.
    expect(
      signed([...sale.legs, ...rollback.legs], Cashbox_type.FOR_MARKET),
    ).toBe(0);
    expect(rollback.legs).toEqual([
      expect.objectContaining({
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 170000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      }),
    ]);
  });

  it('taqqoslash: snapshot NULL bo`lsa (eski xato) rollback filialdan 200 000 yechardi', async () => {
    const sale = makeProviderHarness(PROVIDER_ORDER);
    await sale.s.markByProvider({ order_id: '8001', action: 'sell' });
    const legacyOrder = {
      ...sale.saved[0],
      branch_cashbox_amount: null,
      sale_collectible_amount: null,
    };

    const rollback = makeRollbackHarness(legacyOrder, {
      ...sale.settlements[0],
      isDeleted: false,
    });
    await rollback.s.rollbackOrderToWaiting(SUPERADMIN, '8001');

    expect(signed(rollback.legs, Cashbox_type.BRANCH)).toBe(-200000);
  });
});

describe('fix3b — markProviderSettledToHq: branch_to_hq_by raqam yoki NULL', () => {
  function makeSettlementService() {
    const setCalls: Row[] = [];
    const qb = {
      update: jest.fn(() => qb),
      set: jest.fn((patch: Row) => {
        setCalls.push(patch);
        return qb;
      }),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      execute: jest.fn(() => Promise.resolve({ affected: 2 })),
    };
    const repo = { createQueryBuilder: jest.fn(() => qb) };
    const service = new OrderSettlementService(
      {} as never,
      repo as never,
      {} as never,
    );
    return { service, setCalls };
  }

  it.each([
    ["'system' (integratsiya created_by bermaganda) → NULL", 'system', null],
    ['yo`q → NULL', undefined, null],
    ['partner:7 kabi sun`iy id → NULL', 'partner:7', null],
    ['raqamli foydalanuvchi → o`zi', '42', '42'],
  ])('%s', async (_label, requesterId, expected) => {
    const h = makeSettlementService();

    const res = await h.service.markProviderSettledToHq({
      order_ids: ['8001', '8002'],
      requester_id: requesterId,
    });

    expect(h.setCalls[0]).toMatchObject({
      status: SettlementStatus.BRANCH_SETTLED,
      branch_to_hq_by: expected,
    });
    expect(res).toMatchObject({ data: { affected: 2 } });
  });
});
