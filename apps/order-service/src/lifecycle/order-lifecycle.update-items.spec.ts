/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { RpcException } from '@nestjs/microservices';
import { Order_status } from '@app/common';
import { Order, Order_source } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderServiceService } from '../order-service.service';

/**
 * (52NJNGaH) Tashqi buyurtma mahsulotlarini tahrirlash: `updateFull` →
 * `replaceOrderItems` endi `product_name` ni yozadi, ro'yxatni O'CHIRISHDAN
 * OLDIN tekshiradi va almashtirishni buyurtma bilan bitta tranzaksiyada
 * bajaradi.
 */
function setup(
  existing: Partial<Order> & { items?: Array<Partial<OrderItem>> } = {},
  opts: { insertFails?: boolean } = {},
) {
  const order = {
    id: '1251134',
    status: Order_status.NEW,
    source: Order_source.EXTERNAL,
    market_id: '500',
    customer_id: '77',
    total_price: 300_000,
    product_quantity: 4,
    items: [
      { id: '1', product_id: null, product_name: 'Kitob', quantity: 1 },
      { id: '2', product_id: null, product_name: 'Daftar', quantity: 3 },
    ],
    ...existing,
  };

  const calls: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const itemRepo = {
    delete: jest.fn(async (where: unknown) => {
      calls.push(`delete:${JSON.stringify(where)}`);
      return { affected: 2 };
    }),
    createQueryBuilder: jest.fn(() => ({
      insert: jest.fn().mockReturnThis(),
      values: jest.fn((values: Array<Record<string, unknown>>) => ({
        execute: jest.fn(async () => {
          if (opts.insertFails) {
            throw new Error('insert failed');
          }
          calls.push('insert');
          inserted.push(...values);
          return { identifiers: [] };
        }),
      })),
    })),
  };
  const orderRepo = {
    save: jest.fn(async (value: unknown) => {
      calls.push('save-order');
      return value;
    }),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === Order) return orderRepo;
      if (entity === OrderItem) return itemRepo;
      if (entity === OrderTracking || entity === OrderCustodyEvent) return {};
      throw new Error('Unexpected repository');
    }),
  };
  const queryRunner = {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(async () => {
      calls.push('begin');
    }),
    commitTransaction: jest.fn(async () => {
      calls.push('commit');
    }),
    rollbackTransaction: jest.fn(async () => {
      calls.push('rollback');
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  // Tranzaksiyadan tashqaridagi repo — endi ishlatilmasligi kerak.
  const outerItemRepo = {
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const service = Object.create(OrderLifecycleService.prototype);
  Object.assign(service, {
    orderItemRepo: outerItemRepo,
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    findById: jest.fn(async () => ({
      ...order,
      items: order.items.map((item) => ({ ...item })),
    })),
    transferBatchItemRepo: { find: jest.fn().mockResolvedValue([]) },
    custody: {
      createTrackingEvent: jest.fn(),
      createCustodyEvent: jest.fn(),
      toTrackingRole: jest.fn(() => 'superadmin'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });

  return {
    service: service as OrderLifecycleService,
    itemRepo,
    outerItemRepo,
    orderRepo,
    queryRunner,
    calls,
    inserted,
  };
}

const requester = { id: '1', roles: ['superadmin'] };

async function statusCode(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return Number((error.getError() as { statusCode?: number }).statusCode);
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

describe('52NJNGaH - updateFull: tashqi buyurtma mahsulotlari', () => {
  it('TC1/TC3: product_id=null satrlarida product_name saqlanadi, soni yangilanadi', async () => {
    const h = setup();

    await h.service.updateFull(
      '1251134',
      {
        items: [
          { product_id: null, product_name: 'Kitob', quantity: 2 },
          { product_id: null, product_name: 'Daftar', quantity: 3 },
        ],
      },
      requester,
    );

    expect(h.inserted).toEqual([
      {
        product_id: null,
        product_name: 'Kitob',
        quantity: 2,
        order_id: '1251134',
      },
      {
        product_id: null,
        product_name: 'Daftar',
        quantity: 3,
        order_id: '1251134',
      },
    ]);
    expect(h.orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ product_quantity: 5 }),
    );
  });

  it('TC2: olib tashlangan mahsulot qayta yozilmaydi', async () => {
    const h = setup();

    await h.service.updateFull(
      '1251134',
      { items: [{ product_name: 'Daftar', quantity: 3 }] },
      requester,
    );

    expect(h.inserted).toEqual([
      {
        product_id: null,
        product_name: 'Daftar',
        quantity: 3,
        order_id: '1251134',
      },
    ]);
  });

  it('TC4: katalogli buyurtma avvalgidek (product_id, quantity; nom null)', async () => {
    const h = setup({
      source: Order_source.INTERNAL,
      items: [{ id: '9', product_id: '5', product_name: null, quantity: 1 }],
    });

    await h.service.updateFull(
      '1251134',
      { items: [{ product_id: '5', quantity: 2 }] },
      requester,
    );

    expect(h.inserted).toEqual([
      { product_id: '5', product_name: null, quantity: 2, order_id: '1251134' },
    ]);
  });

  it('almashtirish tranzaksiya ICHIDA: delete → insert → buyurtma → commit', async () => {
    const h = setup();

    await h.service.updateFull(
      '1251134',
      { items: [{ product_name: 'Kitob', quantity: 1 }] },
      requester,
    );

    expect(h.calls).toEqual([
      'begin',
      'delete:{"order_id":"1251134"}',
      'insert',
      'save-order',
      'commit',
    ]);
    expect(h.outerItemRepo.delete).not.toHaveBeenCalled();
  });

  it("yozish yiqilsa tranzaksiya qaytariladi (eski satrlar o'chib qolmaydi)", async () => {
    const h = setup({}, { insertFails: true });

    await expect(
      h.service.updateFull(
        '1251134',
        { items: [{ product_name: 'Kitob', quantity: 1 }] },
        requester,
      ),
    ).rejects.toBeDefined();
    expect(h.calls).toContain('rollback');
    expect(h.calls).not.toContain('commit');
    expect(h.orderRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    ["bo'sh ro'yxat", []],
    ['product_id ham, nom ham yo`q', [{ product_id: null, quantity: 1 }]],
    ["bo'sh nom", [{ product_id: null, product_name: '   ', quantity: 1 }]],
    ['raqam emas product_id', [{ product_id: 'null', quantity: 1 }]],
    ['quantity 0', [{ product_name: 'Kitob', quantity: 0 }]],
    ['kasr quantity', [{ product_name: 'Kitob', quantity: 1.5 }]],
  ])('%s → 400, hech narsa o`chirilmaydi', async (_label, items) => {
    const h = setup();

    expect(
      await statusCode(
        h.service.updateFull('1251134', { items: items as never }, requester),
      ),
    ).toBe(400);
    expect(h.itemRepo.delete).not.toHaveBeenCalled();
    expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('TC5: items yuborilmasa satrlarga umuman tegilmaydi', async () => {
    const h = setup();

    await h.service.updateFull('1251134', { comment: 'izoh' }, requester);

    expect(h.itemRepo.delete).not.toHaveBeenCalled();
    expect(h.inserted).toEqual([]);
  });
});

describe('52NJNGaH - normalizeUpdatePayload (PATCH /orders/:id/full)', () => {
  const normalize = (dto: Record<string, unknown>) =>
    OrderServiceService.prototype.normalizeUpdatePayload.call(
      Object.create(OrderServiceService.prototype),
      dto,
    );

  it('product_id=null "null" matniga aylanmaydi, product_name uzatiladi', () => {
    expect(
      normalize({
        items: [
          { product_id: null, product_name: 'Kitob', quantity: 2 },
          { product_id: 5, quantity: 1 },
          { product_name: 'Daftar' },
        ],
      }).items,
    ).toEqual([
      { product_id: null, product_name: 'Kitob', quantity: 2 },
      { product_id: '5', product_name: null, quantity: 1 },
      { product_id: null, product_name: 'Daftar', quantity: 1 },
    ]);
  });
});
