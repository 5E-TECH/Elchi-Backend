import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { OrderHolderType } from '../entities/order.entity';

/**
 * VkKDSNNn — qaytarish partiyasi (`RETURN`) qabul qilinganda (butun partiya
 * va tanlab) `OrderWarehouseService.onReturnBatchReceived` AYNI
 * tranzaksiyada, buyurtmalar QB yangilanishidan KEYIN chaqiriladi (manzil
 * HQ bo'lsa Markaziy ombor buyurtmasi omborga qaytadi — servis o'zi tekshiradi).
 * `FORWARD` partiya va ombor servisisiz (eski sozlama) — chaqiruv yo'q.
 */
const HQ_ID = '1';

function makeBatchHarness(opts: {
  direction: BranchTransferDirection;
  withWarehouse?: boolean;
  /** Ikkinchi buyurtma (901) holati — sukut WAITING. */
  secondStatus?: Order_status;
}) {
  const batch = {
    id: '70',
    status: BranchTransferBatchStatus.SENT,
    direction: opts.direction,
    source_branch_id: '12',
    destination_branch_id: HQ_ID,
    target_region_id: '7',
    order_count: 2,
    total_price: 0,
    isDeleted: false,
  };
  const items = [
    { id: 'i1', batch_id: '70', order_id: '900', sent_at: new Date() },
    { id: 'i2', batch_id: '70', order_id: '901', sent_at: new Date() },
  ];
  const orders = [
    {
      id: '900',
      region_id: '7',
      status: Order_status.CANCELLED,
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '12',
      holder_courier_id: null,
    },
    {
      id: '901',
      region_id: '8',
      status: opts.secondStatus ?? Order_status.WAITING,
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '12',
      holder_courier_id: null,
    },
  ];
  const calls: string[] = [];
  const qb = () => {
    const chain: Record<string, jest.Mock> = {};
    for (const method of ['update', 'set', 'where', 'andWhere']) {
      chain[method] = jest.fn(() => chain);
    }
    chain.execute = jest.fn(() => {
      calls.push('order.update');
      return Promise.resolve({ affected: 1 });
    });
    return chain;
  };
  const batchRepo = {
    findOne: jest.fn().mockResolvedValue(batch),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const itemRepo = {
    find: jest.fn(({ where }: any) =>
      Promise.resolve(
        where?.order_id
          ? items.filter((item) =>
              (where.order_id.value as string[]).includes(item.order_id),
            )
          : // tanlab qabuldan keyin qolganlar — yo'q
            calls.includes('items.soft_delete')
            ? []
            : items,
      ),
    ),
    createQueryBuilder: jest.fn(() => {
      const chain = qb();
      chain.execute = jest.fn(() => {
        calls.push('items.soft_delete');
        return Promise.resolve({ affected: 1 });
      });
      return chain;
    }),
  };
  const orderRepo = {
    find: jest.fn(({ where }: any) =>
      Promise.resolve(
        orders.filter((order) =>
          (where.id.value as string[]).includes(order.id),
        ),
      ),
    ),
    createQueryBuilder: jest.fn(qb),
  };
  const historyRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(() => {
      calls.push('commit');
    }),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) => {
        if (entity.name === 'BranchTransferBatch') return batchRepo;
        if (entity.name === 'BranchTransferBatchItem') return itemRepo;
        if (entity.name === 'Order') return orderRepo;
        if (entity.name === 'BranchTransferBatchHistory') return historyRepo;
        return {};
      }),
    },
  };
  const custody = {
    toTrackingRole: jest.fn(() => 'manager'),
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    auditActor: jest.fn(() => ({})),
  };
  const orderWarehouse = {
    onReturnBatchReceived: jest.fn(() => {
      calls.push('warehouse.return');
      return Promise.resolve();
    }),
  };
  const service = new BranchTransferBatchService(
    { createQueryRunner: jest.fn(() => queryRunner) } as never,
    {} as never, // transferBatchRepo
    {} as never, // transferBatchItemRepo
    {} as never, // transferBatchHistoryRepo
    {} as never, // orderRepo
    {} as never, // orderTrackingRepo
    {} as never, // orderCustodyEventRepo
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    custody as never,
    (opts.withWarehouse === false ? undefined : orderWarehouse) as never,
  );
  return { service, orderWarehouse, queryRunner, calls };
}

const requester = {
  requester_id: '41',
  requester_name: 'HQ menejeri',
  requester_roles: ['manager'],
};

describe('VkKDSNNn — qaytarish partiyasi qabuli → Markaziy ombor hook', () => {
  it('⭐ butun partiya (RETURN): hook AYNI tranzaksiyada, QB yangilanishidan keyin, commit`dan oldin', async () => {
    const h = makeBatchHarness({ direction: BranchTransferDirection.RETURN });
    await h.service.receiveBranchTransferBatch({
      batch_id: '70',
      ...requester,
    });
    expect(h.orderWarehouse.onReturnBatchReceived).toHaveBeenCalledTimes(1);
    expect(h.orderWarehouse.onReturnBatchReceived).toHaveBeenCalledWith(
      {
        orderIds: ['900', '901'],
        destinationBranchId: HQ_ID,
        priorStatusById: new Map([
          ['900', Order_status.CANCELLED],
          ['901', Order_status.WAITING],
        ]),
        requester: { id: '41', roles: ['manager'] },
      },
      h.queryRunner.manager,
    );
    const hookAt = h.calls.indexOf('warehouse.return');
    expect(hookAt).toBeGreaterThan(h.calls.lastIndexOf('order.update'));
    expect(hookAt).toBeLessThan(h.calls.indexOf('commit'));
  });

  it('⭐ tanlab qabul (RETURN): faqat tanlangan buyurtmalar, commit`dan oldin', async () => {
    const h = makeBatchHarness({ direction: BranchTransferDirection.RETURN });
    await h.service.receiveBranchTransferBatchOrders({
      batch_id: '70',
      order_ids: ['900'],
      ...requester,
    });
    expect(h.orderWarehouse.onReturnBatchReceived).toHaveBeenCalledWith(
      {
        orderIds: ['900'],
        destinationBranchId: HQ_ID,
        priorStatusById: new Map([['900', Order_status.CANCELLED]]),
        requester: { id: '41', roles: ['manager'] },
      },
      h.queryRunner.manager,
    );
    const hookAt = h.calls.indexOf('warehouse.return');
    expect(hookAt).toBeGreaterThan(h.calls.indexOf('order.update'));
    expect(hookAt).toBeLessThan(h.calls.indexOf('commit'));
  });

  it('⭐ partiyada turganida sotilgan buyurtma: hook`ka QB`dan OLDINGI holat (SOLD) uzatiladi — RECEIVED/NEW emas (ikkala yo`l)', async () => {
    const whole = makeBatchHarness({
      direction: BranchTransferDirection.RETURN,
      secondStatus: Order_status.SOLD,
    });
    await whole.service.receiveBranchTransferBatch({
      batch_id: '70',
      ...requester,
    });
    const [wholeInput] = whole.orderWarehouse.onReturnBatchReceived.mock
      .calls[0] as unknown as [{ priorStatusById: Map<string, string> }];
    expect(wholeInput.priorStatusById.get('901')).toBe(Order_status.SOLD);

    const selected = makeBatchHarness({
      direction: BranchTransferDirection.RETURN,
      secondStatus: Order_status.SOLD,
    });
    await selected.service.receiveBranchTransferBatchOrders({
      batch_id: '70',
      order_ids: ['900', '901'],
      ...requester,
    });
    const [selectedInput] = selected.orderWarehouse.onReturnBatchReceived.mock
      .calls[0] as unknown as [{ priorStatusById: Map<string, string> }];
    expect(Array.from(selectedInput.priorStatusById.entries())).toEqual([
      ['900', Order_status.CANCELLED],
      ['901', Order_status.SOLD],
    ]);
  });

  it('FORWARD partiya — hook yo`q; ombor servisi yo`q (eski sozlama) — qabul bugungidek', async () => {
    const forward = makeBatchHarness({
      direction: BranchTransferDirection.FORWARD,
    });
    await forward.service.receiveBranchTransferBatch({
      batch_id: '70',
      ...requester,
    });
    expect(forward.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(forward.orderWarehouse.onReturnBatchReceived).not.toHaveBeenCalled();
    const forwardSelected = makeBatchHarness({
      direction: BranchTransferDirection.FORWARD,
    });
    await forwardSelected.service.receiveBranchTransferBatchOrders({
      batch_id: '70',
      order_ids: ['900'],
      ...requester,
    });
    expect(forwardSelected.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(
      forwardSelected.orderWarehouse.onReturnBatchReceived,
    ).not.toHaveBeenCalled();

    const legacy = makeBatchHarness({
      direction: BranchTransferDirection.RETURN,
      withWarehouse: false,
    });
    await expect(
      legacy.service.receiveBranchTransferBatch({
        batch_id: '70',
        ...requester,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(legacy.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('so`rovchi id`si yo`q — hook aktyori null (soxta `0` emas)', async () => {
    const h = makeBatchHarness({ direction: BranchTransferDirection.RETURN });
    await h.service.receiveBranchTransferBatch({ batch_id: '70' });
    expect(h.orderWarehouse.onReturnBatchReceived).toHaveBeenCalledWith(
      expect.objectContaining({ requester: { id: null, roles: [] } }),
      h.queryRunner.manager,
    );
  });
});
