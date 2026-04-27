import { RpcException } from '@nestjs/microservices';
import { BranchTransferBatchStatus } from '@app/common';
import { OrderServiceService } from './order-service.service';
import { BranchTransferBatch } from './entities/branch-transfer-batch.entity';
import { Order } from './entities/order.entity';
import { BranchTransferBatchHistory } from './entities/branch-transfer-batch-history.entity';

describe('OrderServiceService transfer batch cancel', () => {
  function createSetup(status: BranchTransferBatchStatus) {
    const batchRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '900',
        status,
        isDeleted: false,
      }),
      save: jest.fn().mockImplementation(async (v) => v),
    };
    const historyRepo = {
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const orderUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 3 }),
    };
    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(orderUpdateQb),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === BranchTransferBatch.name) return batchRepo;
          if (entity.name === Order.name) return orderRepo;
          if (entity.name === BranchTransferBatchHistory.name) return historyRepo;
          return {};
        }),
      },
    };

    const service = new OrderServiceService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, batchRepo, historyRepo, orderUpdateQb, queryRunner };
  }

  it('cancels PENDING batch, unassigns orders, and writes reason to history', async () => {
    const { service, historyRepo, orderUpdateQb, queryRunner } = createSetup(
      BranchTransferBatchStatus.PENDING,
    );

    const res: any = await service.cancelBranchTransferBatch({
      batch_id: '900',
      reason: "noto'g'ri viloyat tanlangan",
      requester_id: '77',
      requester_name: '77',
    });

    expect(orderUpdateQb.set).toHaveBeenCalledWith({ current_batch_id: null });
    expect(historyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CANCELLED',
        notes: expect.stringContaining("Sabab: noto'g'ri viloyat tanlangan"),
      }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('rejects cancel when batch is RECEIVED', async () => {
    const { service, queryRunner } = createSetup(BranchTransferBatchStatus.RECEIVED);

    await expect(
      service.cancelBranchTransferBatch({
        batch_id: '900',
        reason: 'received batch cancel test',
      }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('rejects second cancel for already CANCELLED batch', async () => {
    const { service } = createSetup(BranchTransferBatchStatus.CANCELLED);

    await expect(
      service.cancelBranchTransferBatch({
        batch_id: '900',
        reason: 'already cancelled test',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects empty/short reason', async () => {
    const { service } = createSetup(BranchTransferBatchStatus.PENDING);

    await expect(
      service.cancelBranchTransferBatch({
        batch_id: '900',
        reason: 'qisqa',
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
