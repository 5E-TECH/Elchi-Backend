/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await */
import { Order_source, Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

describe('OrderLifecycleService order items (C2.5)', () => {
  function setup() {
    const insertedItems: Array<Record<string, unknown>> = [];
    const orderRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({
        id: '900',
        product_quantity: 0,
        ...value,
      })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const orderItemRepo = {
      createQueryBuilder: jest.fn(() => ({
        insert: jest.fn().mockReturnThis(),
        values: jest.fn((values) => {
          insertedItems.push(...values);
          return {
            execute: jest
              .fn()
              .mockResolvedValue({ identifiers: [{ id: '1' }] }),
          };
        }),
      })),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Order) return orderRepo;
        if (entity === OrderItem) return orderItemRepo;
        if (entity === OrderTracking || entity === OrderCustodyEvent) return {};
        throw new Error(
          `Unexpected repository: ${(entity as { name?: string }).name}`,
        );
      }),
    };
    const queryRunner = {
      manager,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = Object.create(OrderLifecycleService.prototype) as any;
    service.dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    service.resolveBranchIdForOrder = jest.fn().mockResolvedValue(null);
    service.resolveHolderFromState = jest.fn().mockResolvedValue({
      holder_type: 'market',
      holder_branch_id: null,
      holder_courier_id: null,
    });
    service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
    service.findById = jest.fn().mockResolvedValue({ id: '900' });
    service.custody = {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({ user_id: null, user_role: null })),
    };
    service.activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    return { service: service as OrderLifecycleService, insertedItems };
  }

  const base = {
    market_id: '500',
    customer_id: '77',
    source: Order_source.EXTERNAL,
  };

  it('TC1: external item name+qty bilan product_id=null saqlanadi', async () => {
    const { service, insertedItems } = setup();
    await service.create({
      ...base,
      items: [
        { product_id: null, product_name: 'Telefon g‘ilofi', quantity: 2 },
      ],
    });
    expect(insertedItems).toEqual([
      {
        product_id: null,
        product_name: 'Telefon g‘ilofi',
        quantity: 2,
        order_id: '900',
      },
    ]);
  });

  it('TC2: internal product_id oqimi o‘zgarmaydi', async () => {
    const { service, insertedItems } = setup();
    await service.create({
      ...base,
      source: Order_source.INTERNAL,
      items: [{ product_id: '42', quantity: 3 }],
    });
    expect(insertedItems).toEqual([
      {
        product_id: '42',
        product_name: null,
        quantity: 3,
        order_id: '900',
      },
    ]);
  });
});
