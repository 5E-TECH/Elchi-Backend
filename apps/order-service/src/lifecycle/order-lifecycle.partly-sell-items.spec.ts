import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * QISMAN SOTUV — katalogsiz (hamkor) qatorlar butun oqim bo'ylab.
 *
 * ⚠️ Ilgari `partlySellOrder` qatorni faqat `product_id` bo'yicha topardi:
 * BeePost posilkasida `product_id = null` — "Product not found in request:
 * null" (404). Bekor qilingan qism uchun esa `String(null)` = "null" bigint
 * ustunga yozilardi va nom (`product_name`) yo'qolardi.
 *
 * Kassa/settlement hisob-kitobi bu yerda stub — u alohida speclarda qulflangan;
 * bu spec faqat QATORLAR qanday kamayishi va bekor qismga nima yozilishini
 * tekshiradi.
 */

type Row = {
  id: string;
  product_id: string | null;
  product_name: string | null;
  quantity: number;
};

function setup(existingItems: Row[]) {
  const savedItems: Array<{ id: string; quantity: number }> = [];
  const childItems: Array<Record<string, unknown>> = [];
  const orderUpdates: Array<Record<string, unknown>> = [];
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: (entity: unknown) => {
        if (entity === OrderItem) {
          return {
            save: jest.fn((row: Row) => {
              savedItems.push({ id: row.id, quantity: row.quantity });
              return Promise.resolve(row);
            }),
            createQueryBuilder: () => ({
              insert: () => ({
                values: (values: Array<Record<string, unknown>>) => {
                  childItems.push(...values);
                  return { execute: () => Promise.resolve({}) };
                },
              }),
            }),
          };
        }
        if (entity === Order) {
          return {
            create: (value: Record<string, unknown>) => value,
            save: (value: Record<string, unknown>) =>
              Promise.resolve({ id: '9900', ...value }),
            update: (_where: unknown, value: Record<string, unknown>) => {
              orderUpdates.push(value);
              return Promise.resolve({ affected: 1 });
            },
          };
        }
        return {};
      },
    },
  };

  const order = {
    id: '120',
    status: Order_status.WAITING,
    post_id: '9001',
    market_id: '501',
    customer_id: '801',
    total_price: 1000000,
    paid_online_amount: 0,
    where_deliver: 'center',
    branch_id: '77',
    comment: null,
  };

  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  const noop = () => Promise.resolve(undefined);
  Object.assign(s, {
    findById: jest.fn().mockResolvedValue(order),
    logisticsClient: {
      send: () => of({ data: { id: '9001', courier_id: '301' } }),
    },
    resolveActorCourierId: () => '301',
    hasRole: () => false,
    lookup: {
      getMarketsByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '501', tariff_center: 45000, tariff_home: 70000 },
        ]),
      getCouriersByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '301', tariff_center: 30000, tariff_home: 50000 },
        ]),
      getCashboxByUser: jest.fn().mockResolvedValue({ id: 'c', balance: 0 }),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      ensureBranchCashbox: noop,
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    orderItemRepo: {
      find: jest.fn().mockResolvedValue(existingItems),
    },
    resolveHolderFromState: jest.fn().mockResolvedValue({
      holder_type: 'COURIER',
      holder_branch_id: '77',
      holder_courier_id: '301',
    }),
    dataSource: { createQueryRunner: () => queryRunner },
    lockWaitingOrder: noop,
    updateCashboxBalance: noop,
    updateFull: noop,
    recordSaleSettlement: noop,
    custody: {
      createTrackingEvent: noop,
      createCustodyEvent: noop,
      toTrackingRole: () => 'courier',
      auditActor: () => ({}),
    },
    syncOrderToSearch: noop,
    resolveSyncAction: () => null,
    outbox: { enqueue: noop },
    activityLog: { log: noop },
  });

  const partlySell = (
    order_item_info: Array<Record<string, unknown>>,
    totalPrice = 500000,
  ) =>
    s.partlySellOrder({ id: '301', roles: ['courier'] }, '120', {
      order_item_info: order_item_info as never,
      totalPrice,
    });

  return { partlySell, savedItems, childItems, orderUpdates, queryRunner };
}

describe('partlySellOrder — katalogsiz (hamkor) qatorlar', () => {
  it("BeePost #120 shakli: tv ×2 (product_id null) -> 1 dona sotiladi, 1 dona bekor qismga NOMI bilan o'tadi", async () => {
    const t = setup([
      { id: '5501', product_id: null, product_name: 'tv', quantity: 2 },
    ]);

    const res = await t.partlySell([{ order_item_id: '5501', quantity: 1 }]);

    expect(res).toMatchObject({ statusCode: 200 });
    expect(t.savedItems).toEqual([{ id: '5501', quantity: 1 }]);
    expect(t.childItems).toEqual([
      { order_id: '9900', product_id: null, product_name: 'tv', quantity: 1 },
    ]);
    expect(t.orderUpdates).toContainEqual({ product_quantity: 1 });
    expect(t.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('ikkita katalogsiz qator — har biri o`z qatori bo`yicha kamayadi', async () => {
    const t = setup([
      { id: '10', product_id: null, product_name: 'kurtka', quantity: 3 },
      { id: '11', product_id: null, product_name: 'shim', quantity: 2 },
    ]);

    await t.partlySell([
      { order_item_id: '10', quantity: 3 },
      { order_item_id: '11', quantity: 1 },
    ]);

    expect(t.savedItems).toEqual([{ id: '11', quantity: 1 }]);
    expect(t.childItems).toEqual([
      { order_id: '9900', product_id: null, product_name: 'shim', quantity: 1 },
    ]);
  });

  it('regressiya: katalog qatori product_id bo`yicha avvalgidek', async () => {
    const t = setup([
      { id: '1', product_id: '4', product_name: 'Telefon', quantity: 10 },
    ]);

    await t.partlySell([{ product_id: '4', quantity: 3 }], 1500000);

    expect(t.savedItems).toEqual([{ id: '1', quantity: 3 }]);
    expect(t.childItems).toEqual([
      {
        order_id: '9900',
        product_id: '4',
        product_name: null,
        quantity: 7,
      },
    ]);
  });

  it("eski frontend xatosi (qator id'sini product_id sifatida) — 404 va tranzaksiya OCHILMAYDI", async () => {
    const t = setup([
      { id: '5501', product_id: null, product_name: 'tv', quantity: 2 },
    ]);

    const error = await t
      .partlySell([{ product_id: '5501', quantity: 1 }])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 404,
    });
    expect(t.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(t.childItems).toEqual([]);
  });
});
