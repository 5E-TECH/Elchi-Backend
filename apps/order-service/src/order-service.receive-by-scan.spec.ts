import { RpcException } from '@nestjs/microservices';
import {
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { OrderHolderType } from './entities/order.entity';
import { BranchTransferBatchService } from './transfer-batch/branch-transfer-batch.service';

/**
 * P1b — `receiveOneOrderByScan` guardlari.
 *
 * Bu metod kuryerga posilkani O'ZIGA YOZIB OLISH huquqini beradi, shuning uchun
 * guardlar butun xavfsizlik hikoyasi: bo'shatilsa kuryer jismonan yetib
 * kelmagan posilkani qabul qilingan deb belgilaydi va mas'uliyat zanjiri
 * (custody) buziladi. Har bir guard shu yerda qulflangan.
 *
 * Ikkinchi muhim jihat: bu metod partial-receive'dan FARQLI — paketni
 * YOPMAYDI va qolgan buyurtmalarga TEGMAYDI. Oxirgi ikki test shuni tekshiradi.
 */
function chainableQb() {
  const setCalls: Array<Record<string, unknown>> = [];
  const qb: Record<string, unknown> = {};
  const chain = () => qb;
  Object.assign(qb, {
    update: jest.fn(chain),
    set: jest.fn((payload: Record<string, unknown>) => {
      setCalls.push(payload);
      return qb;
    }),
    where: jest.fn(chain),
    andWhere: jest.fn(chain),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
    __setCalls: setCalls,
  });
  return qb as any;
}

function setup(options: {
  order?: Record<string, unknown> | null;
  batch?: Record<string, unknown> | null;
  item?: Record<string, unknown> | null;
  remainingItems?: number;
}) {
  const order =
    options.order === null
      ? null
      : {
          id: '900',
          status: Order_status.ON_THE_ROAD,
          current_batch_id: '700',
          holder_type: OrderHolderType.HQ,
          holder_branch_id: '1',
          holder_courier_id: null,
          ...options.order,
        };

  const batch =
    options.batch === null
      ? null
      : {
          id: '700',
          status: BranchTransferBatchStatus.SENT,
          direction: BranchTransferDirection.FORWARD,
          destination_branch_id: '10',
          source_branch_id: '1',
          ...options.batch,
        };

  const item =
    options.item === null
      ? null
      : { id: 'i1', batch_id: '700', order_id: '900', sent_at: new Date(), ...options.item };

  const orderQb = chainableQb();
  const itemQb = chainableQb();

  const orderRepo = {
    findOne: jest.fn(() => Promise.resolve(order)),
    createQueryBuilder: jest.fn(() => orderQb),
  };
  const batchRepo = {
    findOne: jest.fn(() => Promise.resolve(batch)),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  const itemRepo = {
    findOne: jest.fn(() => Promise.resolve(item)),
    createQueryBuilder: jest.fn(() => itemQb),
    count: jest.fn(() => Promise.resolve(options.remainingItems ?? 0)),
  };
  const historyRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  const genericRepo = { create: jest.fn((x: unknown) => x), save: jest.fn() };

  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) => {
        switch (entity.name) {
          case 'Order':
            return orderRepo;
          case 'BranchTransferBatch':
            return batchRepo;
          case 'BranchTransferBatchItem':
            return itemRepo;
          case 'BranchTransferBatchHistory':
            return historyRepo;
          default:
            return genericRepo;
        }
      }),
    },
  };

  const custody = {
    toTrackingRole: jest.fn(() => 'courier'),
    auditActor: jest.fn(() => ({ user_id: '5', user_role: 'courier' })),
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
  };

  const service = new BranchTransferBatchService(
    { createQueryRunner: jest.fn(() => queryRunner) } as any,
    batchRepo as any,
    itemRepo as any,
    historyRepo as any,
    orderRepo as any,
    {} as any,
    {} as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
    custody as any,
  );

  return { service, orderRepo, batchRepo, itemRepo, orderQb, itemQb, custody, queryRunner };
}

const CALL = {
  order_id: '900',
  courier_branch_id: '10',
  requester_id: '5',
  requester_roles: ['courier'],
};

describe('receiveOneOrderByScan — guardlar', () => {
  it('buyurtma paketda yo‘lda emas -> received:false (yozuv yo‘q)', async () => {
    const { service, orderQb } = setup({ order: { current_batch_id: null } });

    const res: any = await service.receiveOneOrderByScan(CALL);

    expect(res.data).toEqual({ received: false, reason: 'no_batch' });
    expect(orderQb.execute).not.toHaveBeenCalled();
  });

  it('paket BOSHQA filialga atalgan -> received:false (yozuv yo‘q)', async () => {
    const { service, orderQb } = setup({
      batch: { destination_branch_id: '77' },
    });

    const res: any = await service.receiveOneOrderByScan(CALL);

    expect(res.data).toEqual({ received: false, reason: 'other_branch' });
    expect(orderQb.execute).not.toHaveBeenCalled();
  });

  // Eng muhim guard: PENDING = posilka HQ'dan JISMONAN chiqmagan.
  it('paket hali jo‘natilmagan (PENDING) -> 400', async () => {
    const { service, orderQb } = setup({
      batch: { status: BranchTransferBatchStatus.PENDING },
    });

    await expect(service.receiveOneOrderByScan(CALL)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(orderQb.execute).not.toHaveBeenCalled();
  });

  it('paket bekor qilingan -> 400', async () => {
    const { service } = setup({
      batch: { status: BranchTransferBatchStatus.CANCELLED },
    });
    await expect(service.receiveOneOrderByScan(CALL)).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('qaytarish paketi (RETURN) skan orqali qabul qilinmaydi -> 400', async () => {
    const { service } = setup({
      batch: { direction: BranchTransferDirection.RETURN },
    });
    await expect(service.receiveOneOrderByScan(CALL)).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('buyurtma paket ichida yo‘q -> 400', async () => {
    const { service } = setup({ item: null });
    await expect(service.receiveOneOrderByScan(CALL)).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('buyurtma topilmadi -> 404', async () => {
    const { service } = setup({ order: null });
    await expect(service.receiveOneOrderByScan(CALL)).rejects.toBeInstanceOf(
      RpcException,
    );
  });
});

describe('receiveOneOrderByScan — muvaffaqiyatli qabul', () => {
  it('buyurtma filialga o‘tadi: branch_id + RECEIVED + holder=BRANCH', async () => {
    const { service, orderQb, custody } = setup({ remainingItems: 3 });

    const res: any = await service.receiveOneOrderByScan(CALL);

    expect(res.data.received).toBe(true);
    expect(res.data.branch_id).toBe('10');
    expect(orderQb.__setCalls[0]).toEqual(
      expect.objectContaining({
        current_batch_id: null,
        branch_id: '10',
        status: Order_status.RECEIVED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: '10',
        holder_courier_id: null,
      }),
    );
    // Custody zanjiri uzilmaydi: HQ -> BRANCH yozuvi bo'ladi.
    expect(custody.createTrackingEvent).toHaveBeenCalledTimes(1);
    expect(custody.createCustodyEvent).toHaveBeenCalledTimes(1);
  });

  // PARTIAL-RECEIVE'DAN ASOSIY FARQ: paket ochiq qoladi, qolganlar tegilmaydi.
  it('paketda boshqa buyurtmalar qolsa -> paket YOPILMAYDI', async () => {
    const { service, batchRepo } = setup({ remainingItems: 3 });

    const res: any = await service.receiveOneOrderByScan(CALL);

    expect(res.data.batch_closed).toBe(false);
    expect(batchRepo.save).not.toHaveBeenCalled();
  });

  it('oxirgi buyurtma qabul qilinsa -> paket RECEIVED bo‘lib yopiladi', async () => {
    const { service, batchRepo } = setup({ remainingItems: 0 });

    const res: any = await service.receiveOneOrderByScan(CALL);

    expect(res.data.batch_closed).toBe(true);
    expect(batchRepo.save).toHaveBeenCalledTimes(1);
    expect(batchRepo.save.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: BranchTransferBatchStatus.RECEIVED,
        received_by_user_id: '5',
      }),
    );
  });

  it('allaqachon RECEIVED bo‘lgan buyurtmada ortiqcha tracking yozilmaydi', async () => {
    const { service, custody } = setup({
      order: { status: Order_status.RECEIVED },
      remainingItems: 1,
    });

    await service.receiveOneOrderByScan(CALL);

    expect(custody.createTrackingEvent).not.toHaveBeenCalled();
  });
});
