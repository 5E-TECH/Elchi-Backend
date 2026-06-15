import { RpcException } from '@nestjs/microservices';
import { OrderServiceService } from './order-service.service';
import { Order_status, BranchTransferBatchStatus, BranchTransferDirection } from '@app/common';
import { Order, OrderHolderType } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';

describe('OrderServiceService return flow', () => {
  function makeService(options?: {
    orderStatus?: Order_status;
    hasReceivedReturnBatch?: boolean;
    branchId?: string;
    homeBranchId?: string;
    holderType?: OrderHolderType;
    holderBranchId?: string | null;
    returnRequested?: boolean;
  }) {
    const order = {
      id: '101',
      status: options?.orderStatus ?? Order_status.WAITING,
      branch_id: options?.branchId ?? '10',
      home_branch_id: options?.homeBranchId ?? '10',
      holder_type: options?.holderType,
      holder_branch_id:
        options?.holderBranchId === undefined ? null : options.holderBranchId,
      return_requested: options?.returnRequested ?? false,
      return_reason: null,
      isDeleted: false,
    } as any;

    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn(async (entity: any) => entity),
    };

    const transferBatchItemQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue(options?.hasReceivedReturnBatch === false ? null : { item_id: '1' }),
    };
    const transferBatchItemRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(transferBatchItemQb),
    };

    const trackingRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
    };

    const custodyRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === Order.name) return orderRepo;
          if (entity.name === OrderTracking.name) return trackingRepo;
          if (entity.name === OrderCustodyEvent.name) return custodyRepo;
          return {};
        }),
      },
    };

    const outbox = { enqueue: jest.fn() };

    // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
    // Faqat shu test ishlatadigan repolar haqiqiy mock, qolgani {}.
    const service = new OrderServiceService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any, // dataSource
      orderRepo as any, // orderRepo
      {} as any, // orderItemRepo
      trackingRepo as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // orderSettlementRepo
      {} as any, // transferBatchRepo
      transferBatchItemRepo as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // searchClient
      {} as any, // identityClient
      {} as any, // logisticsClient
      {} as any, // catalogClient
      {} as any, // financeClient
      {} as any, // integrationClient
      {} as any, // branchClient
      {} as any, // fileClient
      outbox as any, // outbox
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as any, // activityLog
    );

    return { service, orderRepo, transferBatchItemQb, trackingRepo, queryRunner, outbox };
  }

  async function expectRpc(promise: Promise<unknown>, code: number) {
    try {
      await promise;
      throw new Error('expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect(((error as RpcException).getError() as any)?.statusCode).toBe(code);
    }
  }

  it('initiateReturn requires reason', async () => {
    const { service } = makeService();
    await expectRpc(service.initiateReturn({ id: '1', roles: ['admin'] }, '101', { reason: '' }), 400);
  });

  it('initiateReturn rejects disallowed status', async () => {
    const { service } = makeService({ orderStatus: Order_status.SOLD });
    await expectRpc(
      service.initiateReturn({ id: '1', roles: ['admin'] }, '101', { reason: 'Mijoz rad etdi' }),
      400,
    );
  });

  it('initiateReturn stores reason and return_requested and writes history', async () => {
    const { service, orderRepo, trackingRepo, queryRunner } = makeService({
      orderStatus: Order_status.WAITING,
    });

    const res: any = await service.initiateReturn(
      { id: '7', roles: ['admin'] },
      '101',
      { reason: 'Adres noto‘g‘ri bo‘lgani uchun qaytarilsin' },
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        return_requested: true,
        return_reason: 'Adres noto‘g‘ri bo‘lgani uchun qaytarilsin',
      }),
    );
    expect(trackingRepo.save).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket requires order to be received in return batch', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: false,
    });

    await expectRpc(service.markReturnedToMarket({ id: '9', roles: ['operator'] }, '101'), 400);
  });

  it('markReturnedToMarket sets final status and history once', async () => {
    const { service, orderRepo, trackingRepo, transferBatchItemQb } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['operator'] },
      '101',
    );

    expect(transferBatchItemQb.andWhere).toHaveBeenCalledWith(
      'batch.direction = :direction',
      { direction: BranchTransferDirection.RETURN },
    );
    expect(transferBatchItemQb.andWhere).toHaveBeenCalledWith(
      'batch.status = :status',
      { status: BranchTransferBatchStatus.RECEIVED },
    );
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Order_status.RETURNED_TO_MARKET,
        return_requested: false,
      }),
    );
    expect(trackingRepo.save).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket cannot run twice', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RETURNED_TO_MARKET,
    });

    await expectRpc(service.markReturnedToMarket({ id: '9', roles: ['operator'] }, '101'), 400);
  });

  it('markReturnedToMarket direct path: home-branch courier + return_requested (no batch)', async () => {
    const { service, orderRepo } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.COURIER,
      holderBranchId: '10', // courier belongs to the home branch
      returnRequested: true,
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['manager'] },
      '101',
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Order_status.RETURNED_TO_MARKET,
        return_requested: false,
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket direct path: order held by home branch + return_requested', async () => {
    const { service, orderRepo } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '10',
      returnRequested: true,
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['manager'] },
      '101',
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.RETURNED_TO_MARKET }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket rejects direct handover when courier is not at home branch', async () => {
    const { service } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.COURIER,
      holderBranchId: '99', // courier of a different (non-home) branch
      returnRequested: true,
    });

    await expectRpc(
      service.markReturnedToMarket({ id: '9', roles: ['manager'] }, '101'),
      400,
    );
  });

  it('markReturnedToMarket rejects direct handover without return_requested', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '10',
      returnRequested: false,
    });

    await expectRpc(
      service.markReturnedToMarket({ id: '9', roles: ['manager'] }, '101'),
      400,
    );
  });
});
