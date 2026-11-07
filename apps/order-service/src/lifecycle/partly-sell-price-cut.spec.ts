/**
 * Narx tushirib qisman sotuv (ega 2026-11-07, BeePost'dagidek).
 *
 * Kuryer mijozga boradi, mijoz 500 000 lik mahsulotni 350 000 ga oladi, market
 * telefonda rozi bo'ladi. Kuryer mahsulot sonini O'ZGARTIRMASDAN «Qisman sotish»
 * bilan 350 000 ni yuboradi (1 dona ham, ko'p dona ham). Talablar:
 *   • market tasdig'i, isbot, chegara qo'shilmaydi; izoh ixtiyoriy;
 *   • bekor qilingan bola buyurtma OCHILMAYDI (hech narsa qaytmaydi);
 *   • asl summa `partly_sell_original_total_price` ga yoziladi va rollback uni
 *     AYNAN qaytaradi (bola yo'q — qo'shib tiklab bo'lmaydi);
 *   • soni ham, summa ham o'zgarmasa — 400 (bu oddiy sotuv);
 *   • mahsuloti kamaygan qisman sotuv avvalgidek (bola bor, ustun yozilmaydi).
 *
 * Uslub: `Object.create(prototype)` + stub (KmWO9gTA sale-pricing spec kabi).
 * `partlySellOrder`, `recordSaleSettlement` va `mergePartialChildrenBack` HAQIQIY.
 */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';
import { extraCostApprovalTable } from '../testing/extra-cost-kit-spec';

type Row = Record<string, any>;
type Svc = OrderLifecycleService & Record<string, any>;

const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };

const MARKET: Row = {
  id: '501',
  tariff_center: 45000,
  tariff_home: 70000,
  expense_proof_conditions: [],
  extra_cost_enabled: true,
};
const COURIER_ROW: Row = {
  id: '289',
  tariff_center: 30000,
  tariff_home: 50000,
  can_add_extra_cost: true,
  can_sell_cancel: true,
};
/** 1 xil mahsulot, 1 dona, 500 000 — egasining misoli. */
const ONE_ITEM: Row[] = [
  {
    id: '11',
    order_id: '7001',
    product_id: '4',
    product_name: null,
    quantity: 1,
  },
];
/** 2 xil mahsulot (2 + 1 dona), 250 000. */
const TWO_ITEMS: Row[] = [
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
  total_price: 500000,
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
  partly_sell_original_total_price: null,
};

function makeWorld(opts: { order?: Row; items?: Row[] } = {}) {
  const items = opts.items ?? ONE_ITEM;
  const order: Row = { ...WAITING_ORDER, ...(opts.order ?? {}) };
  const legs: Row[] = [];
  const updates: Row[] = [];
  const settlements: Row[] = [];
  const children: Row[] = [];
  const logs: Row[] = [];
  // Ota buyurtmaga `update` (masalan `product_quantity`) — tekshiruv uchun.
  const orderUpdate = jest.fn().mockResolvedValue({ affected: 1 });

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
      if (entity === OrderExtraCostApproval) return extraCostApprovalTable();
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
          update: orderUpdate,
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
  const custody = {
    auditActor: jest.fn(() => ({})),
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'courier'),
  };

  // `w.s.x` orqali murojaat `unbound-method` lint xatosini beradi — mock'lar
  // alohida qaytariladi.
  const mocks = {
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    resolveHolderFromState: jest.fn().mockResolvedValue({
      holder_type: 'COURIER',
      holder_branch_id: '77',
      holder_courier_id: '289',
    }),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    ...mocks,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: {
      log: jest.fn((entry: Row) => {
        logs.push(entry);
        return Promise.resolve();
      }),
    },
    custody,
    orderItemRepo: {
      find: jest.fn(() => Promise.resolve(items.map((item) => ({ ...item })))),
    },
    lookup: {
      getMarketsByIds: jest.fn(() => Promise.resolve([{ ...MARKET }])),
      getCouriersByIds: jest.fn(() => Promise.resolve([{ ...COURIER_ROW }])),
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn(() => Promise.resolve({ ...order })),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
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

  return {
    s,
    mocks,
    legs,
    updates,
    settlements,
    children,
    logs,
    custody,
    orderUpdate,
  };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('xato kutilgan edi');
}

const leg = (legs: Row[], type: Cashbox_type) =>
  legs.filter((l) => l.cashbox_type === type);

describe('Narx tushirib qisman sotuv — partlySellOrder', () => {
  it('⭐ 1 dona 500 000 → 350 000: sotiladi, bola yo`q, asl summa saqlanadi, pul 350 000 dan', async () => {
    const w = makeWorld();

    await w.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [{ order_item_id: '11', quantity: 1 }],
      totalPrice: 350000,
    });

    expect(w.updates).toHaveLength(1);
    expect(w.updates[0]).toMatchObject({
      status: Order_status.SOLD,
      total_price: 350000,
      partly_sell_original_total_price: 500000,
      sale_collectible_amount: 350000,
      // Market tarifi 45 000 (markazga) — market 305 000 oladi.
      to_be_paid: 305000,
    });
    // Market: +305 000; kuryer: 350 000 − 30 000 ulush = +320 000.
    expect(leg(w.legs, Cashbox_type.FOR_MARKET)).toEqual([
      expect.objectContaining({
        amount: 305000,
        operation_type: Operation_type.INCOME,
      }),
    ]);
    expect(leg(w.legs, Cashbox_type.FOR_COURIER)).toEqual([
      expect.objectContaining({
        amount: 320000,
        operation_type: Operation_type.INCOME,
      }),
    ]);
    expect(w.settlements).toHaveLength(1);
    expect(w.settlements[0]).toMatchObject({
      market_amount: 305000,
      courier_amount: 320000,
    });
    // Hech narsa qaytmadi — bekor qilingan bola ham, uning izi ham yo'q.
    expect(w.children).toHaveLength(0);
    expect(w.custody.createCustodyEvent).not.toHaveBeenCalled();
    expect(w.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(w.mocks.resolveHolderFromState).not.toHaveBeenCalled();
    // Market tasdig'i so'ralmaydi (qo'shimcha xarajat yo'q) — darhol sotiladi.
    expect(w.mocks.requestExtraCostApprovalIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ extraCost: 0 }),
    );
    const log = w.logs.find((entry) => entry.action === 'order.partly_sell');
    expect(log?.old_value).toMatchObject({ total_price: 500000 });
    expect(log?.new_value).toMatchObject({ total_price: 350000 });
    expect(log?.metadata).toMatchObject({
      cancelled_items: 0,
      price_cut_only: true,
      original_total_price: 500000,
    });
  });

  it('⭐ 2 xil mahsulot, soni o`zgarmagan, 250 000 → 200 000 — sotiladi, bola yo`q', async () => {
    const w = makeWorld({ items: TWO_ITEMS, order: { total_price: 250000 } });

    await w.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [
        { product_id: '4', quantity: 2 },
        { product_id: '5', quantity: 1 },
      ],
      totalPrice: 200000,
    });

    expect(w.updates[0]).toMatchObject({
      total_price: 200000,
      partly_sell_original_total_price: 250000,
    });
    expect(w.children).toHaveLength(0);
  });

  it('soni ham, summa ham o`zgarmagan — 400, tranzaksiya ochilmaydi, pul yo`q', async () => {
    const w = makeWorld();

    const error = await rpcError(
      w.s.partlySellOrder(COURIER, '7001', {
        order_item_info: [{ order_item_id: '11', quantity: 1 }],
        totalPrice: 500000,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('oddiy «Sotish»');
    expect(w.mocks.lockWaitingOrder).not.toHaveBeenCalled();
    expect(w.legs).toHaveLength(0);
    expect(w.updates).toHaveLength(0);
  });

  it('0 so`m ham qabul qilinadi (BeePost kabi chegara yo`q) — asl summa saqlanadi', async () => {
    const w = makeWorld();

    await w.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [{ order_item_id: '11', quantity: 1 }],
      totalPrice: 0,
    });

    expect(w.updates[0]).toMatchObject({
      total_price: 0,
      partly_sell_original_total_price: 500000,
    });
    expect(w.children).toHaveLength(0);
  });

  it('filiali aniqlanmagan buyurtma ham sotiladi (bola filiali kerak emas)', async () => {
    const w = makeWorld({
      order: { holder_branch_id: null, branch_id: null, home_branch_id: null },
    });

    await w.s.partlySellOrder(
      { id: '289', roles: ['courier'], branch_id: null },
      '7001',
      {
        order_item_info: [{ order_item_id: '11', quantity: 1 }],
        totalPrice: 350000,
      },
    );

    expect(w.updates[0]).toMatchObject({ total_price: 350000 });
  });

  // Ko'rib chiqish topilmasi: bir xil katalog mahsuloti ikki qatorda, so'rovda
  // bitta `product_id` qatori (to'g'ridan-to'g'ri API). Ikkala qator shu
  // so'rov qatoriga moslanadi; `product_quantity` so'rov yig'indisi (1) emas,
  // qatorlarga yozilgan MOSLANGAN son (2) bo'lishi kerak.
  it('product_quantity — moslangan qatorlar yig`indisi (so`rov yig`indisi emas)', async () => {
    const w = makeWorld({
      items: [
        { id: '21', product_id: '4', quantity: 1, product_name: 'Soat' },
        { id: '22', product_id: '4', quantity: 1, product_name: 'Soat' },
      ],
      order: { total_price: 200000, product_quantity: 2 },
    });

    await w.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [{ product_id: '4', quantity: 1 }],
      totalPrice: 150000,
    });

    expect(w.children).toHaveLength(0);
    expect(w.orderUpdate).toHaveBeenCalledWith(
      { id: '7001' },
      { product_quantity: 2 },
    );
  });

  it('regressiya: mahsuloti kamaygan qisman sotuv — bola bor, asl summa ustuni yozilmaydi', async () => {
    const w = makeWorld({ items: TWO_ITEMS, order: { total_price: 250000 } });

    await w.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [
        { product_id: '4', quantity: 1 },
        { product_id: '5', quantity: 1 },
      ],
      totalPrice: 150000,
    });

    expect(w.updates[0]).toMatchObject({ total_price: 150000 });
    expect(w.updates[0]).not.toHaveProperty('partly_sell_original_total_price');
    expect(w.children).toHaveLength(1);
    expect(w.children[0]).toMatchObject({
      total_price: 100000,
      status: Order_status.CANCELLED,
    });
    expect(w.custody.createCustodyEvent).toHaveBeenCalledTimes(1);
    const log = w.logs.find((entry) => entry.action === 'order.partly_sell');
    expect(log?.metadata).not.toHaveProperty('price_cut_only');
  });
});

/** Rollback: `mergePartialChildrenBack` (haqiqiy) — soxta EntityManager bilan. */
function makeMergeWorld(parent: Row, children: Row[] = []) {
  const db = { parent: { ...parent } };
  const orderRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...db.parent })),
    find: jest.fn(() =>
      Promise.resolve(children.map((child) => ({ ...child }))),
    ),
    save: jest.fn((row: Row) => {
      if (String(row.id) === String(db.parent.id)) db.parent = { ...row };
      return Promise.resolve(row);
    }),
  };
  const itemRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((row: Row) => Promise.resolve(row)),
    create: jest.fn((row: Row) => row),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === OrderItem ? itemRepo : orderRepo,
    ),
  };
  const syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    voidOpenExtraCostApprovals: jest.fn().mockResolvedValue(undefined),
    removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
    syncOrderToSearch,
  });
  // `mergePartialChildrenBack` private — `Svc` orqali `any`; aniq imzo beriladi.
  const typed = s as unknown as {
    mergePartialChildrenBack(
      manager: unknown,
      order: Row,
      requester: { id: string },
    ): Promise<number>;
  };
  const merge = (): Promise<number> =>
    typed.mergePartialChildrenBack(
      manager,
      { id: String(db.parent.id) },
      { id: '1' },
    );
  return { db, orderRepo, merge, syncOrderToSearch };
}

describe('Narx tushirib qisman sotuv — rollback asl summani qaytaradi', () => {
  it('⭐ 350 000 ga sotilgan, asl 500 000 — rollback 500 000 ni AYNAN qaytaradi, ustun tozalanadi', async () => {
    const w = makeMergeWorld({
      id: '7001',
      total_price: 350000,
      product_quantity: 1,
      partly_sell_original_total_price: 500000,
    });

    const merged = await w.merge();

    expect(merged).toBe(0);
    expect(w.db.parent).toMatchObject({
      total_price: 500000,
      partly_sell_original_total_price: null,
      product_quantity: 1,
    });
    expect(w.syncOrderToSearch).toHaveBeenCalledTimes(1);
  });

  it('narx tushirilmagan va bolasiz buyurtma — hech narsa yozilmaydi (avvalgidek)', async () => {
    const w = makeMergeWorld({
      id: '7001',
      total_price: 500000,
      product_quantity: 1,
      partly_sell_original_total_price: null,
    });

    expect(await w.merge()).toBe(0);
    expect(w.orderRepo.save).not.toHaveBeenCalled();
    expect(w.db.parent.total_price).toBe(500000);
  });

  it('regressiya: mahsuloti kamaygan sotuv — summa bola orqali QO`SHIB tiklanadi', async () => {
    const w = makeMergeWorld(
      {
        id: '7001',
        total_price: 150000,
        product_quantity: 2,
        partly_sell_original_total_price: null,
      },
      [
        {
          id: '9900',
          total_price: 100000,
          product_quantity: 1,
          status: Order_status.CANCELLED,
        },
      ],
    );

    expect(await w.merge()).toBe(1);
    expect(w.db.parent).toMatchObject({
      total_price: 250000,
      product_quantity: 3,
    });
  });

  /**
   * Ko'rib chiqish topilmasi (2026-11-07): ustundagi summa — otaning narx
   * tushirishdan OLDINGI o'z summasi; avvalgi (mahsuloti kamaygan) qisman
   * sotuvdan qolgan bola summasi unga KIRMAYDI. Misol: 3 dona 600 000 → 2 dona
   * 500 000 ga sotildi (bola 1 dona 100 000, bekor pochtada — birinchi
   * rollback'da birlashmadi), keyin 2 dona 500 000 → 350 000 narx tushirildi.
   * Rollback: 500 000 (ustun) + 100 000 (bola) = 600 000, 3 dona.
   */
  it('ustun va avvalgi sotuvdan qolgan bola — summa ustunga bola QO`SHILIB tiklanadi', async () => {
    const w = makeMergeWorld(
      {
        id: '7001',
        total_price: 350000,
        product_quantity: 2,
        partly_sell_original_total_price: 500000,
      },
      [
        {
          id: '9900',
          total_price: 100000,
          product_quantity: 1,
          status: Order_status.CANCELLED,
        },
      ],
    );

    expect(await w.merge()).toBe(1);

    expect(w.db.parent).toMatchObject({
      total_price: 600000,
      product_quantity: 3,
      partly_sell_original_total_price: null,
    });
  });

  it('sotish → rollback → yana sotish → rollback: har safar aynan 500 000', async () => {
    const w = makeMergeWorld({
      id: '7001',
      total_price: 350000,
      product_quantity: 1,
      partly_sell_original_total_price: 500000,
    });
    await w.merge();
    expect(w.db.parent.total_price).toBe(500000);

    // Ikkinchi sotuv 400 000 ga (partlySellOrder yozgani kabi).
    w.db.parent = {
      ...w.db.parent,
      total_price: 400000,
      partly_sell_original_total_price: 500000,
    };
    await w.merge();
    expect(w.db.parent).toMatchObject({
      total_price: 500000,
      partly_sell_original_total_price: null,
    });

    // Uchinchi rollback (ustun bo'sh) — summa o'zgarmaydi.
    await w.merge();
    expect(w.db.parent.total_price).toBe(500000);
  });
});

describe('Narx tushirib qisman sotuv — ustunni PATCH (updateFromApi) bilan o`zgartirib bo`lmaydi', () => {
  it('superadmin ham `partly_sell_original_total_price` ni PATCH qila olmaydi — 400', async () => {
    const s = Object.create(OrderLifecycleService.prototype) as Svc;
    Object.assign(s, {
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });

    const error = await rpcError(
      s.updateFromApi(
        '7001',
        { partly_sell_original_total_price: 1 },
        { id: '1', roles: ['superadmin'] },
      ),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('partly_sell_original_total_price');
  });
});
